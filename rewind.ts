/**
 * Rewind Extension
 *
 * Adds /rewind command with tree-based target selection and three rewind modes:
 * - Conversation + changes
 * - Conversation only
 * - Changes only
 *
 * File rewind is git-free and tracks only write/edit tool calls.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { TreeSelectorComponent } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "crypto";
import { copyFile, mkdir, rename, rm, stat, unlink } from "fs/promises";
import { dirname, isAbsolute, join, resolve } from "path";

type RewindMode = "conversation+changes" | "conversation-only" | "changes-only";
const REWIND_CUSTOM_TYPE = "rewind.snapshot.v1";
const REWIND_ACTION_CUSTOM_TYPE = "rewind.action.v1";
const REWIND_UNDO_CUSTOM_TYPE = "rewind.undo.v1";
const REWIND_MARKER_REGEX = /\s*⟲\s*rewound/g;

interface PersistedSnapshotData {
	version: 1;
	entryId: string;
	path: string;
	beforeSnapshotPath: string | undefined;
	existedBefore: boolean;
}

interface PersistedUndoOperation {
	path: string;
	beforeSnapshotPath: string | undefined;
	existedBefore: boolean;
}

interface PersistedRewindAction {
	version: 1;
	actionId: string;
	mode: RewindMode;
	previousLeafId: string | null;
	targetId: string;
	undoOperations: PersistedUndoOperation[];
}

interface PersistedRewindUndo {
	version: 1;
	actionId: string;
}

interface SnapshotRecord {
	path: string;
	absPath: string;
	beforeSnapshotPath: string | undefined;
	existedBefore: boolean;
	toolCallId: string;
}

interface RewindPlan {
	targetId: string;
	operations: SnapshotRecord[];
	totalEntries: number;
}

interface PersistRestoreContext {
	cwd: string;
	sessionManager: {
		getEntries(): Array<{
			type: string;
			id: string;
			customType?: string;
			data?: unknown;
		}>;
		getLabel(entryId: string): string | undefined;
	};
}

function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function collapseOperationsByPath<T extends { absPath: string }>(operations: T[]): T[] {
	const seen = new Set<string>();
	const collapsed: T[] = [];

	for (let i = operations.length - 1; i >= 0; i--) {
		const op = operations[i];
		if (seen.has(op.absPath)) continue;
		seen.add(op.absPath);
		collapsed.push(op);
	}

	collapsed.reverse();
	return collapsed;
}

function isPersistedSnapshotData(value: unknown): value is PersistedSnapshotData {
	if (typeof value !== "object" || value === null) return false;
	const data = value as Record<string, unknown>;
	return (
		data.version === 1 &&
		typeof data.entryId === "string" &&
		typeof data.path === "string" &&
		(data.beforeSnapshotPath === undefined || typeof data.beforeSnapshotPath === "string") &&
		typeof data.existedBefore === "boolean"
	);
}

function isPersistedUndoOperation(value: unknown): value is PersistedUndoOperation {
	if (typeof value !== "object" || value === null) return false;
	const data = value as Record<string, unknown>;
	return (
		typeof data.path === "string" &&
		(data.beforeSnapshotPath === undefined || typeof data.beforeSnapshotPath === "string") &&
		typeof data.existedBefore === "boolean"
	);
}

function isPersistedRewindAction(value: unknown): value is PersistedRewindAction {
	if (typeof value !== "object" || value === null) return false;
	const data = value as Record<string, unknown>;
	if (data.version !== 1) return false;
	if (typeof data.actionId !== "string") return false;
	if (data.mode !== "conversation+changes" && data.mode !== "conversation-only" && data.mode !== "changes-only") {
		return false;
	}
	if (data.previousLeafId !== null && typeof data.previousLeafId !== "string") return false;
	if (typeof data.targetId !== "string") return false;
	if (!Array.isArray(data.undoOperations)) return false;
	for (const op of data.undoOperations) {
		if (!isPersistedUndoOperation(op)) return false;
	}
	return true;
}

function isPersistedRewindUndo(value: unknown): value is PersistedRewindUndo {
	if (typeof value !== "object" || value === null) return false;
	const data = value as Record<string, unknown>;
	return data.version === 1 && typeof data.actionId === "string";
}

function stripRewindMarker(label: string): string {
	return label.replace(REWIND_MARKER_REGEX, "").trim();
}

export default function rewindExtension(pi: ExtensionAPI) {
	const pendingByToolCallId = new Map<string, SnapshotRecord>();
	const operationsByEntryId = new Map<string, SnapshotRecord[]>();
	const fileLocks = new Map<string, Promise<void>>();
	let latestRewindAction: PersistedRewindAction | undefined;
	const undoneActionIds = new Set<string>();
	let activeRewindTargetId: string | undefined;

	const clearRuntimeState = () => {
		pendingByToolCallId.clear();
		operationsByEntryId.clear();
		fileLocks.clear();
		latestRewindAction = undefined;
		undoneActionIds.clear();
		activeRewindTargetId = undefined;
	};

	const restorePersistedState = (ctx: PersistRestoreContext) => {
		operationsByEntryId.clear();
		latestRewindAction = undefined;
		undoneActionIds.clear();

		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === REWIND_CUSTOM_TYPE) {
				if (!isPersistedSnapshotData(entry.data)) continue;

				const data = entry.data;
				const record: SnapshotRecord = {
					path: data.path,
					absPath: resolvePath(ctx.cwd, data.path),
					beforeSnapshotPath: data.beforeSnapshotPath,
					existedBefore: data.existedBefore,
					toolCallId: `persisted:${entry.id}`,
				};

				const list = operationsByEntryId.get(data.entryId) ?? [];
				list.push(record);
				operationsByEntryId.set(data.entryId, list);
				continue;
			}

			if (entry.customType === REWIND_ACTION_CUSTOM_TYPE && isPersistedRewindAction(entry.data)) {
				latestRewindAction = entry.data;
				continue;
			}

			if (entry.customType === REWIND_UNDO_CUSTOM_TYPE && isPersistedRewindUndo(entry.data)) {
				undoneActionIds.add(entry.data.actionId);
			}
		}
	};

	pi.on("session_start", (_event, ctx) => {
		clearRuntimeState();
		restorePersistedState(ctx);
		rebuildRewindMarkers(ctx, true);
	});

	pi.on("session_switch", (_event, ctx) => {
		clearRuntimeState();
		restorePersistedState(ctx);
		rebuildRewindMarkers(ctx, true);
	});

	const captureFileSnapshot = async (
		absPath: string,
		snapshotsDir: string,
		suffix: string,
	): Promise<{ existedBefore: boolean; beforeSnapshotPath: string | undefined }> => {
		let existedBefore = false;
		let beforeSnapshotPath: string | undefined;
		try {
			const stats = await stat(absPath);
			existedBefore = stats.isFile();
		} catch {
			existedBefore = false;
		}
		if (existedBefore) {
			const snapshotId = `${Date.now()}-${randomUUID()}.${suffix}`;
			beforeSnapshotPath = join(snapshotsDir, snapshotId);
			await copyFile(absPath, beforeSnapshotPath);
		}
		return { existedBefore, beforeSnapshotPath };
	};

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		const rawPath = event.input.path;
		if (typeof rawPath !== "string" || rawPath.trim().length === 0) return;

		const absPath = resolvePath(ctx.cwd, rawPath);

		const prev = fileLocks.get(absPath) ?? Promise.resolve();
		const current = prev.then(async () => {
			const sessionId = ctx.sessionManager.getSessionId();
			const snapshotsDir = join(ctx.cwd, ".pi", "rewind", "snapshots", sessionId);
			await mkdir(snapshotsDir, { recursive: true });

			const { existedBefore, beforeSnapshotPath } = await captureFileSnapshot(absPath, snapshotsDir, "before");

			pendingByToolCallId.set(event.toolCallId, {
				path: rawPath,
				absPath,
				beforeSnapshotPath,
				existedBefore,
				toolCallId: event.toolCallId,
			});
		});
		fileLocks.set(absPath, current.catch(() => {}));
		await current;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		const snapshot = pendingByToolCallId.get(event.toolCallId);
		if (!snapshot) return;
		pendingByToolCallId.delete(event.toolCallId);

		if (event.isError) {
			if (snapshot.beforeSnapshotPath) {
				await rm(snapshot.beforeSnapshotPath, { force: true });
			}
			return;
		}

		const leaf = ctx.sessionManager.getLeafEntry();
		if (!leaf) return;

		const existing = operationsByEntryId.get(leaf.id) ?? [];
		existing.push(snapshot);
		operationsByEntryId.set(leaf.id, existing);

		pi.appendEntry<PersistedSnapshotData>(REWIND_CUSTOM_TYPE, {
			version: 1,
			entryId: leaf.id,
			path: snapshot.path,
			beforeSnapshotPath: snapshot.beforeSnapshotPath,
			existedBefore: snapshot.existedBefore,
		});
	});

	const pickTreeTarget = async (ctx: ExtensionCommandContext): Promise<string | undefined> => {
		const tree = ctx.sessionManager.getTree();
		if (tree.length === 0) return undefined;

		return ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) => {
			const selector = new TreeSelectorComponent(
				tree,
				ctx.sessionManager.getLeafId(),
				tui.terminal.rows,
				(entryId) => done(entryId),
				() => done(undefined),
			);
			return selector;
		});
	};

	const applyFileOperations = async (
		operations: Array<{ absPath: string; path: string; beforeSnapshotPath: string | undefined; existedBefore: boolean }>,
		concurrency = 8,
	) => {
		if (operations.length === 0) {
			return { restored: 0, removed: 0, errors: [] as string[] };
		}

		const safeConcurrency = Math.max(1, Math.min(concurrency, operations.length));
		let nextIndex = 0;

		const workers = Array.from({ length: safeConcurrency }, async () => {
			let restored = 0;
			let removed = 0;
			const errors: string[] = [];

			while (true) {
				const index = nextIndex;
				nextIndex++;
				if (index >= operations.length) break;

				const op = operations[index];
				try {
					if (op.existedBefore) {
						if (!op.beforeSnapshotPath) {
							errors.push(`${op.path}: missing snapshot`);
							continue;
						}
						await mkdir(dirname(op.absPath), { recursive: true });
						const tempPath = `${op.absPath}.rewind-tmp-${randomUUID()}`;
						try {
							await copyFile(op.beforeSnapshotPath, tempPath);
							await rename(tempPath, op.absPath);
						} catch (error) {
							await rm(tempPath, { force: true });
							throw error;
						}
						restored++;
					} else {
						try {
							await unlink(op.absPath);
							removed++;
						} catch (error) {
							const code =
								typeof error === "object" && error !== null && "code" in error
									? (error as { code?: string }).code
									: undefined;
							if (code !== "ENOENT") throw error;
						}
					}
				} catch (error) {
					errors.push(`${op.path}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}

			return { restored, removed, errors };
		});

		const results = await Promise.all(workers);
		let restored = 0;
		let removed = 0;
		const errors: string[] = [];
		for (const result of results) {
			restored += result.restored;
			removed += result.removed;
			errors.push(...result.errors);
		}

		return { restored, removed, errors };
	};

	const computeRewindPlan = (
		targetId: string,
		currentLeafId: string | null,
		ctx: ExtensionCommandContext,
	): RewindPlan | undefined => {
		if (!currentLeafId) {
			return { targetId, operations: [], totalEntries: 0 };
		}

		const branch = ctx.sessionManager.getBranch(currentLeafId);
		const targetIndex = branch.findIndex((entry) => entry.id === targetId);
		if (targetIndex === -1) {
			return undefined;
		}

		const entriesAfterTarget = branch.slice(targetIndex + 1);
		const operations: SnapshotRecord[] = [];

		for (const entry of entriesAfterTarget) {
			const entryOps = operationsByEntryId.get(entry.id);
			if (!entryOps || entryOps.length === 0) continue;
			for (let i = entryOps.length - 1; i >= 0; i--) {
				operations.push(entryOps[i]);
			}
		}

		return {
			targetId,
			operations,
			totalEntries: entriesAfterTarget.length,
		};
	};

	const captureUndoOperations = async (
		ctx: ExtensionCommandContext,
		operations: SnapshotRecord[],
		concurrency = 8,
	): Promise<PersistedUndoOperation[]> => {
		const sessionId = ctx.sessionManager.getSessionId();
		const snapshotsDir = join(ctx.cwd, ".pi", "rewind", "snapshots", sessionId);
		await mkdir(snapshotsDir, { recursive: true });

		if (operations.length === 0) return [];

		const safeConcurrency = Math.max(1, Math.min(concurrency, operations.length));
		const undoOps = new Array<PersistedUndoOperation>(operations.length);
		let nextIndex = 0;

		await Promise.all(
			Array.from({ length: safeConcurrency }, async () => {
				while (true) {
					const index = nextIndex;
					nextIndex++;
					if (index >= operations.length) return;

					const op = operations[index];
					const { existedBefore, beforeSnapshotPath } = await captureFileSnapshot(op.absPath, snapshotsDir, "undo-before");
					undoOps[index] = {
						path: op.path,
						beforeSnapshotPath,
						existedBefore,
					};
				}
			}),
		);

		return undoOps;
	};

	const getLatestActionState = (): {
		latestAction: PersistedRewindAction | undefined;
		undone: Set<string>;
	} => {
		return { latestAction: latestRewindAction, undone: undoneActionIds };
	};

	const setRewindMarker = (ctx: PersistRestoreContext, entryId: string, marked: boolean) => {
		const current = ctx.sessionManager.getLabel(entryId);
		const base = current ? stripRewindMarker(current) : "";
		const marker = "⟲ rewound";
		const next = marked ? (base.length > 0 ? `${base} ${marker}` : marker) : base.length > 0 ? base : undefined;
		if (next !== current) {
			pi.setLabel(entryId, next);
		}
	};

	const rebuildRewindMarkers = (ctx: PersistRestoreContext, full = false) => {
		const { latestAction, undone } = getLatestActionState();
		const activeTargetId =
			latestAction && !undone.has(latestAction.actionId) ? latestAction.targetId : undefined;

		if (full) {
			for (const entry of ctx.sessionManager.getEntries()) {
				setRewindMarker(ctx, entry.id, activeTargetId === entry.id);
			}
			activeRewindTargetId = activeTargetId;
			return;
		}

		if (activeTargetId === activeRewindTargetId) return;

		if (activeRewindTargetId) {
			setRewindMarker(ctx, activeRewindTargetId, false);
		}
		if (activeTargetId) {
			setRewindMarker(ctx, activeTargetId, true);
		}

		activeRewindTargetId = activeTargetId;
	};

	const undoLastRewind = async (ctx: ExtensionCommandContext) => {
		const { latestAction, undone } = getLatestActionState();
		if (!latestAction || undone.has(latestAction.actionId)) {
			ctx.ui.notify("No rewind action available to undo. Use /rewind first.", "warning");
			return;
		}
		const action = latestAction;

		if (action.mode === "conversation+changes" || action.mode === "conversation-only") {
			if (!action.previousLeafId) {
				ctx.ui.notify("Cannot undo conversation rewind from root", "warning");
				return;
			}
			const nav = await ctx.navigateTree(action.previousLeafId, { summarize: false });
			if (nav.cancelled) {
				ctx.ui.notify("Undo rewind cancelled", "warning");
				return;
			}
		}

		let undoFileCount = 0;
		if ((action.mode === "conversation+changes" || action.mode === "changes-only") && action.undoOperations.length > 0) {
			const ops = action.undoOperations.map(op => ({ ...op, absPath: resolvePath(ctx.cwd, op.path) }));
			undoFileCount = ops.length;
			if (ops.length >= 50) {
				ctx.ui.notify(`Applying undo to ${ops.length} files...`, "info");
			}
			const result = await applyFileOperations(ops);
			if (result.errors.length > 0) {
				ctx.ui.notify(
					`Undo completed with errors (restored ${result.restored}, removed ${result.removed}, errors ${result.errors.length}, files ${undoFileCount})`,
					"warning",
				);
				return;
			}
		}

		pi.appendEntry<PersistedRewindUndo>(REWIND_UNDO_CUSTOM_TYPE, {
			version: 1,
			actionId: action.actionId,
		});
		undoneActionIds.add(action.actionId);

		rebuildRewindMarkers(ctx);

		ctx.ui.notify(
			undoFileCount > 0 ? `Undo rewind completed (files ${undoFileCount})` : "Undo rewind completed",
			"info",
		);
	};

	pi.registerCommand("rewind", {
		description: "Rewind to a tree node",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/rewind requires interactive mode", "warning");
				return;
			}

			rebuildRewindMarkers(ctx);

			const targetId = await pickTreeTarget(ctx);
			if (!targetId) return;

			const modeChoice = await ctx.ui.select("Rewind scope", [
				"Conversation + changes",
				"Conversation only",
				"Changes only",
			]);
			if (!modeChoice) return;

			const mode: RewindMode =
				modeChoice === "Conversation + changes"
					? "conversation+changes"
					: modeChoice === "Conversation only"
						? "conversation-only"
						: "changes-only";

			const currentLeafId = ctx.sessionManager.getLeafId();
			const previousLeafId = currentLeafId ?? null;
			const rewindPlan = computeRewindPlan(targetId, previousLeafId, ctx);

			if ((mode === "conversation+changes" || mode === "changes-only") && !rewindPlan) {
				ctx.ui.notify(
					"Changes rewind is only supported when target is an ancestor on the current branch",
					"warning",
				);
				return;
			}

			let summarize = false;
			let customInstructions: string | undefined;

			if (mode !== "changes-only") {
				while (true) {
					const summaryChoice = await ctx.ui.select("Summarize branch?", [
						"No summary",
						"Summarize",
						"Summarize with custom prompt",
					]);

					if (!summaryChoice) return;
					summarize = summaryChoice !== "No summary";

					if (summaryChoice === "Summarize with custom prompt") {
						customInstructions = await ctx.ui.editor("Custom summarization instructions");
						if (customInstructions === undefined) continue;
					}

					break;
				}
			}

			if (mode !== "changes-only") {
				const nav = await ctx.navigateTree(targetId, {
					summarize,
					customInstructions,
				});
				if (nav.cancelled) {
					ctx.ui.notify("Rewind cancelled", "warning");
					return;
				}
			}

			if (mode === "conversation+changes" || mode === "changes-only") {
				if (!rewindPlan) {
					ctx.ui.notify("No changes available to rewind", "warning");
					return;
				}
				const collapsedOperations = collapseOperationsByPath(rewindPlan.operations);
				if (collapsedOperations.length >= 50) {
					ctx.ui.notify(`Applying rewind to ${collapsedOperations.length} files...`, "info");
				}
				const undoOperations = await captureUndoOperations(ctx, collapsedOperations);
				const result = await applyFileOperations(collapsedOperations);
				const actionId = randomUUID();
				pi.appendEntry<PersistedRewindAction>(REWIND_ACTION_CUSTOM_TYPE, {
					version: 1,
					actionId,
					mode,
					previousLeafId,
					targetId,
					undoOperations,
				});
				latestRewindAction = {
					version: 1,
					actionId,
					mode,
					previousLeafId,
					targetId,
					undoOperations,
				};
				rebuildRewindMarkers(ctx);
				if (result.errors.length > 0) {
					ctx.ui.notify(
						`Rewind completed with errors (restored ${result.restored}, removed ${result.removed}, errors ${result.errors.length}, files ${collapsedOperations.length}, ops ${rewindPlan.operations.length}). Use /rewind-undo to revert.`,
						"warning",
					);
				} else {
					ctx.ui.notify(
						`Changes rewound (restored ${result.restored}, removed ${result.removed}) across ${rewindPlan.totalEntries} entries (files ${collapsedOperations.length}, ops ${rewindPlan.operations.length}). Use /rewind-undo to revert this rewind.`,
						"info",
					);
				}
				return;
			}

			const actionId = randomUUID();
			pi.appendEntry<PersistedRewindAction>(REWIND_ACTION_CUSTOM_TYPE, {
				version: 1,
				actionId,
				mode,
				previousLeafId,
				targetId,
				undoOperations: [],
			});
			latestRewindAction = {
				version: 1,
				actionId,
				mode,
				previousLeafId,
				targetId,
				undoOperations: [],
			};
			rebuildRewindMarkers(ctx);

			ctx.ui.notify("Conversation rewound. Use /rewind-undo to revert this rewind.", "info");
		},
	});

	pi.registerCommand("rewind-undo", {
		description: "Undo last rewind",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/rewind-undo requires interactive mode", "warning");
				return;
			}
			await undoLastRewind(ctx);
		},
	});

	pi.registerCommand("rewind-clean", {
		description: "Clean up rewind snapshots for this session",
		handler: async (_args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			const snapshotsDir = join(ctx.cwd, ".pi", "rewind", "snapshots", sessionId);
			try {
				await rm(snapshotsDir, { recursive: true, force: true });
				ctx.ui.notify(`Cleaned snapshots for session ${sessionId}`, "info");
			} catch (error) {
				ctx.ui.notify(`Failed to clean snapshots: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		},
	});
}
