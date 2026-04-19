import * as vscode from 'vscode';

import inlinedScript from './inlinedScript';

const STORAGE_KEY = 'workspaceTimes_v2';
const LEGACY_STORAGE_KEY = 'workspaceTimes';
const HEARTBEAT_INTERVAL_MS = 30_000;

type DayRecord = {
	total: number;
	editing: number;
};

type WorkspaceTimes = {
	[workspaceName: string]: {
		[date: string]: DayRecord;
	};
};

type LegacyWorkspaceTimes = {
	[workspaceName: string]: {
		[date: string]: number;
	};
};

let lastActivityTimestamp = 0;
let lastEditTimestamp = 0;
let activeWorkspaceName: string | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

function formatLocalDate(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return `${y}-${m}-${d}`;
}

function getToday(): string {
	return formatLocalDate(new Date());
}

function getNonce(): string {
	let text = '';
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}

function formatTimeShort(seconds: number): string {
	const totalMinutes = Math.round(seconds / 60);
	const hours = Math.floor(totalMinutes / 60);
	const mins = totalMinutes % 60;
	return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

function migrateData(context: vscode.ExtensionContext): void {
	const existing = context.globalState.get<WorkspaceTimes>(STORAGE_KEY);
	if (existing && Object.keys(existing).length > 0) {
		return;
	}
	const legacy = context.globalState.get<LegacyWorkspaceTimes>(LEGACY_STORAGE_KEY);
	if (!legacy) {
		return;
	}
	const migrated: WorkspaceTimes = {};
	for (const [workspace, dates] of Object.entries(legacy)) {
		migrated[workspace] = {};
		for (const [date, seconds] of Object.entries(dates)) {
			migrated[workspace][date] = { total: seconds, editing: 0 };
		}
	}
	context.globalState.update(STORAGE_KEY, migrated);
}

export function activate(context: vscode.ExtensionContext) {
	context.globalState.setKeysForSync([STORAGE_KEY]);
	migrateData(context);

	// Status bar item
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	statusBarItem.command = 'spacetime.viewStats';
	context.subscriptions.push(statusBarItem);

	const updateActiveWorkspace = (): boolean => {
		const previous = activeWorkspaceName;
		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document.uri.scheme === 'file') {
			const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
			if (folder) {
				activeWorkspaceName = folder.name;
				return previous !== activeWorkspaceName;
			}
		}
		if (!activeWorkspaceName) {
			const folders = vscode.workspace.workspaceFolders;
			if (folders && folders.length > 0) {
				activeWorkspaceName = folders[0].name;
				return previous !== activeWorkspaceName;
			}
		}
		return false;
	};
	updateActiveWorkspace();

	const recordActivity = () => {
		lastActivityTimestamp = Date.now();
		if (updateActiveWorkspace()) {
			updateStatusBar(context.globalState.get<WorkspaceTimes>(STORAGE_KEY, {}));
		}
	};

	const recordEdit = () => {
		lastEditTimestamp = Date.now();
		recordActivity();
	};

	const getMaxIdleMs = (): number => {
		const minutes = vscode.workspace.getConfiguration('spacetime').get<number>('maxIdleMinutes', 5);
		return minutes * 60 * 1000;
	};

	const updateStatusBar = (workspaceTimes: WorkspaceTimes) => {
		if (!activeWorkspaceName) {
			statusBarItem.hide();
			return;
		}
		const date = getToday();
		const record = workspaceTimes[activeWorkspaceName]?.[date];
		const totalStr = formatTimeShort(record?.total ?? 0);
		const editingSec = record?.editing ?? 0;
		const editingPart = editingSec > 0 ? ` $(edit) ${formatTimeShort(editingSec)}` : '';
		statusBarItem.text = `$(clock) ${totalStr}${editingPart}`;
		statusBarItem.tooltip = `Spacetime: ${totalStr} today` +
			(editingSec > 0 ? ` (Editing: ${formatTimeShort(editingSec)})` : '') +
			'\nClick to view stats';
		statusBarItem.show();
	};

	let lastTickTimestamp = Date.now();

	const tick = async (now: number = Date.now()): Promise<void> => {
		const elapsedMs = now - lastTickTimestamp;
		lastTickTimestamp = now;
		if (!activeWorkspaceName) { return; }
		if (elapsedMs <= 0) { return; }
		const maxIdle = getMaxIdleMs();
		if (now - lastActivityTimestamp > maxIdle) { return; }

		// Cap elapsed time to the heartbeat interval to avoid runaway accumulation
		// (e.g. after system sleep).
		const cappedMs = Math.min(elapsedMs, HEARTBEAT_INTERVAL_MS);
		const seconds = cappedMs / 1000;
		const date = getToday();
		const workspaceTimes = context.globalState.get<WorkspaceTimes>(STORAGE_KEY, {});
		if (!workspaceTimes[activeWorkspaceName]) {
			workspaceTimes[activeWorkspaceName] = {};
		}
		if (!workspaceTimes[activeWorkspaceName][date]) {
			workspaceTimes[activeWorkspaceName][date] = { total: 0, editing: 0 };
		}
		workspaceTimes[activeWorkspaceName][date].total += seconds;
		if (now - lastEditTimestamp <= maxIdle) {
			workspaceTimes[activeWorkspaceName][date].editing += seconds;
		}
		await context.globalState.update(STORAGE_KEY, workspaceTimes);
		updateStatusBar(workspaceTimes);
	};

	// Heartbeat timer: accumulates time every 30s if user was recently active
	heartbeatTimer = setInterval(() => { void tick(); }, HEARTBEAT_INTERVAL_MS);

	context.subscriptions.push({
		dispose: () => {
			if (heartbeatTimer) {
				clearInterval(heartbeatTimer);
				heartbeatTimer = undefined;
			}
			// Final flush of any time accrued since the last tick.
			void tick();
		}
	});

	// Activity event listeners
	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument(() => recordEdit()),
		vscode.window.onDidChangeActiveTextEditor(() => recordActivity()),
		vscode.window.onDidChangeTextEditorSelection(() => recordActivity()),
		vscode.workspace.onDidSaveTextDocument(() => recordEdit()),
	);

	// Record initial activity and update status bar
	recordActivity();
	updateStatusBar(context.globalState.get<WorkspaceTimes>(STORAGE_KEY, {}));

	// View Stats command
	const disposable = vscode.commands.registerCommand('spacetime.viewStats', () => {
		const panel = vscode.window.createWebviewPanel(
			'spacetime-stats',
			'Spacetime Stats',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [
					vscode.Uri.joinPath(context.extensionUri, 'assets'),
					vscode.Uri.joinPath(context.extensionUri, 'media'),
				],
			}
		);

		const nonce = getNonce();
		const dayMs = 86_400_000;
		const today = getToday();
		const sevenDaysAgo = formatLocalDate(new Date(Date.now() - dayMs * 7));
		const logoURI = panel.webview.asWebviewUri(
			vscode.Uri.joinPath(context.extensionUri, 'assets', 'Logo.png')
		);
		const chartJsURI = panel.webview.asWebviewUri(
			vscode.Uri.joinPath(context.extensionUri, 'media', 'chart.umd.js')
		);
		const workspaceTimes = context.globalState.get<WorkspaceTimes>(STORAGE_KEY, {});
		const dataJson = JSON.stringify(workspaceTimes).replace(/<\//g, '<\\/');

		panel.webview.html = getWebviewHtml(nonce, panel, logoURI, chartJsURI, sevenDaysAgo, today, dataJson);
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {
	// Cleanup is handled via context.subscriptions disposables.
}

function getWebviewHtml(
	nonce: string,
	panel: vscode.WebviewPanel,
	logoURI: vscode.Uri,
	chartJsURI: vscode.Uri,
	sevenDaysAgo: string,
	today: string,
	dataJson: string
): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}' ${panel.webview.cspSource}; style-src 'unsafe-inline';">
	<title>Spacetime Stats</title>
	<style>
		h1 { font-size: 2.5em; }
		h2 { font-size: 1.75em; }

		input, select {
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			outline: none; border: none; box-shadow: none;
			padding: 0.5em;
		}
		select {
			appearance: none;
			padding: 0.7em 0.5em;
			min-width: 80px;
		}
		.select-wrapper {
			display: inline-block;
			position: relative;
		}
		.select-wrapper:after {
			content: '';
			display: block;
			position: absolute;
			background: var(--vscode-input-foreground);
			width: 0.7em; height: 0.4em;
			top: 50%; right: 0.7em; margin-top: -0.2em;
			clip-path: polygon(100% 0%, 0 0%, 50% 100%);
		}
		input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(1); }
		.vscode-light input, .vscode-light select { border: 1px solid #ccc; }
		.vscode-light input[type="date"]::-webkit-calendar-picker-indicator { filter: none; }
		.vscode-high-contrast input, .vscode-high-contrast select { border: 1px solid white; }

		.heading {
			display: flex; flex-wrap: wrap;
			justify-content: space-between; align-items: center;
			margin: 20px 0;
		}
		.date-inputs input { margin: 0 0.25em; }
		.input-container { padding: 1em 0.5em; }
		.heading h1 { margin: 0; }
		.header-wrapper { display: flex; align-items: center; }
		.header-wrapper img { width: 80px; height: 80px; margin-right: 1em; }
		.chart-section { max-width: 1200px; padding-bottom: 40px; }

		thead {
			background: rgba(100,100,100,0.25);
			border-bottom: 1px solid rgba(100,100,100,0.5);
		}
		tbody tr { background: rgba(100,100,100,0.10); }
		tbody tr:nth-child(2n) { background: rgba(100,100,100,0.25); }
		th, td { text-align: left; min-width: 120px; padding: 1em; }
		th:not(:last-child), td:not(:last-child) {
			border-right: 1px solid rgba(100,100,100,0.5);
		}
		.vscode-light thead { background: rgba(100,100,100,0.1); border-bottom: 1px solid rgba(100,100,100,0.25); }
		.vscode-light tbody tr { background: rgba(100,100,100,0.03); }
		.vscode-light tbody tr:nth-child(2n) { background: rgba(100,100,100,0.1); }
		.vscode-light th:not(:last-child), .vscode-light td:not(:last-child) { border-right: 1px solid rgba(100,100,100,0.25); }

		table { border-collapse: collapse; font-size: 16px; width: 100%; max-width: 1000px; }
		.workspace-color {
			display: inline-block; width: 14px; height: 14px;
			margin-right: 0.25em; vertical-align: middle;
		}
		.totals-section { padding-bottom: 100px; }
	</style>
</head>
<body>
	<div class="heading">
		<div class="header-wrapper">
			<img src="${logoURI}" />
			<h1>Spacetime Stats</h1>
		</div>
		<div class="input-container">
			<div class="date-inputs">
				<div class="select-wrapper"><select id="mode">
					<option value="total" selected>Total Time</option>
					<option value="editing">Editing Time</option>
				</select></div>
				From
				<input type="date" id="start" name="start" value="${sevenDaysAgo}" max="${today}">
				to
				<input type="date" id="end" name="end" value="${today}" max="${today}">
				<div class="select-wrapper"><select id="group">
					<option value="daily" selected>Daily</option>
					<option value="weekly">Weekly</option>
					<option value="monthly">Monthly</option>
					<option value="yearly">Yearly</option>
				</select></div>
			</div>
		</div>
	</div>
	<section class="chart-section">
		<canvas id="chart"></canvas>
	</section>
	<section class="totals-section">
		<h2>Totals</h2>
		<table>
			<thead>
				<tr>
					<th>Workspace</th>
					<th>Total Time</th>
					<th>Editing Time</th>
					<th>% Editing</th>
				</tr>
			</thead>
			<tbody id="table-body"></tbody>
		</table>
	</section>

	<script nonce="${nonce}" src="${chartJsURI}"></script>
	<script nonce="${nonce}">
		window.workspaceTimes = ${dataJson}
	</script>
	<script nonce="${nonce}">
		${extractFunctionBody(inlinedScript)}
	</script>
</body>
</html>`;
}

/**
 * Extracts the body of a single-expression arrow/function by slicing
 * between the first `{` and the last `}` in its source. Robust to
 * differences in TS emit formatting (unlike splitting on newlines).
 */
function extractFunctionBody(fn: (...args: unknown[]) => unknown): string {
	const src = fn.toString();
	const start = src.indexOf('{');
	const end = src.lastIndexOf('}');
	if (start === -1 || end === -1 || end <= start) {
		throw new Error('Spacetime: failed to extract inlined script body');
	}
	return src.slice(start + 1, end);
}

