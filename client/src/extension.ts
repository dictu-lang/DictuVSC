import * as path from 'path';
import * as vscode from 'vscode';
import { workspace, ExtensionContext, window, commands, Terminal, Uri } from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;
let dictuTerminal: Terminal | undefined;

function getDictuTerminal(): Terminal {
	// Reuse existing terminal if still alive
	if (dictuTerminal && !dictuTerminal.exitStatus) {
		return dictuTerminal;
	}
	dictuTerminal = window.createTerminal({
		name: 'Dictu'
	});
	return dictuTerminal;
}

export function activate(context: ExtensionContext) {
	// ─── Language Server ──────────────────────────────────────────────

	const serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'server.js')
	);
	const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: debugOptions
		}
	};

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'dictu' }],
		synchronize: {
			fileEvents: workspace.createFileSystemWatcher('**/*.du')
		}
	};

	client = new LanguageClient(
		'dictuLanguageServer',
		'Dictu Language Server',
		serverOptions,
		clientOptions
	);

	client.start();

	// ─── Run Dictu File Command ───────────────────────────────────────

	const runFileCmd = commands.registerCommand('dictu.runFile', () => {
		const editor = window.activeTextEditor;
		if (!editor) {
			window.showErrorMessage('No active Dictu file to run.');
			return;
		}

		const doc = editor.document;
		if (doc.languageId !== 'dictu') {
			window.showErrorMessage('The active file is not a Dictu file.');
			return;
		}

		// Save the file before running
		doc.save().then(() => {
			const filePath = doc.fileName;
			const terminal = getDictuTerminal();
			terminal.show(true);
			terminal.sendText(`dictu "${filePath}"`);
		});
	});

	// ─── Run Dictu Selection Command ──────────────────────────────────

	const runSelectionCmd = commands.registerCommand('dictu.runSelection', () => {
		const editor = window.activeTextEditor;
		if (!editor) {
			window.showErrorMessage('No active editor.');
			return;
		}

		const selection = editor.selection;
		const text = selection.isEmpty
			? editor.document.lineAt(selection.active.line).text
			: editor.document.getText(selection);

		if (!text.trim()) {
			window.showInformationMessage('Nothing selected to run.');
			return;
		}

		// Write selection to a temp approach: just send to terminal
		const terminal = getDictuTerminal();
		terminal.show(true);
		// Use echo + pipe for small snippets
		const escapedText = text.replace(/"/g, '\\"');
		terminal.sendText(`echo "${escapedText}" | dictu`);
	});

	// ─── Create New Dictu File Command ────────────────────────────────

	const newFileCmd = commands.registerCommand('dictu.newFile', async () => {
		const doc = await workspace.openTextDocument({
			language: 'dictu',
			content: '// Dictu script\n\n'
		});
		await window.showTextDocument(doc);
	});

	// ─── Toggle Comment Command ───────────────────────────────────────
	// VS Code handles this via language-configuration.json automatically,
	// but we register an explicit one for block comments.

	const blockCommentCmd = commands.registerCommand('dictu.toggleBlockComment', () => {
		commands.executeCommand('editor.action.blockComment');
	});

	// ─── Status Bar ───────────────────────────────────────────────────

	const statusBarItem = window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBarItem.command = 'dictu.runFile';
	statusBarItem.text = '$(play) Run Dictu';
	statusBarItem.tooltip = 'Run current Dictu file';

	function updateStatusBar() {
		const editor = window.activeTextEditor;
		if (editor && editor.document.languageId === 'dictu') {
			statusBarItem.show();
		} else {
			statusBarItem.hide();
		}
	}

	updateStatusBar();
	context.subscriptions.push(
		window.onDidChangeActiveTextEditor(() => updateStatusBar())
	);

	// ─── Register Disposables ─────────────────────────────────────────

	context.subscriptions.push(
		runFileCmd,
		runSelectionCmd,
		newFileCmd,
		blockCommentCmd,
		statusBarItem
	);

	// Clean up terminal on close
	context.subscriptions.push(
		window.onDidCloseTerminal((t) => {
			if (t === dictuTerminal) {
				dictuTerminal = undefined;
			}
		})
	);
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
