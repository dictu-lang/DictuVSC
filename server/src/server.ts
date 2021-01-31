/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult,
	CompletionParams,
	TextEdit,
	Range,
	Position,
	MarkupContent,
	MarkupKind,
	InsertTextFormat
} from 'vscode-languageserver/node';

import dictuLanguage from './language.json';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

const keywords: string[] = dictuLanguage.keywords;
const builtIns: string[] = dictuLanguage.builtins;
const resolveExplainations: {[key: string]: {documentation: string; detail: string}} = dictuLanguage.explainations;
const builtInModules: {name: string; methods: string[]}[] = dictuLanguage.modules;
const snippets: {[key: string]: {content: string, detail: string}} = dictuLanguage.snippets;

let knownSymbols: CompletionItem[] = [];

connection.onInitialize((params: InitializeParams) => {
	let capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			completionProvider: {
				resolveProvider: true,
				triggerCharacters: ['.']
			},
			// definitionProvider : true
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

// The example settings
interface ExampleSettings {
	maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
let documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <ExampleSettings>(
			(change.settings.dictuLanguageServer || defaultSettings)
		);
	}

	// Revalidate all open text documents
	// documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'dictuLanguageServer'
		});
		documentSettings.set(resource, result);
	}
	return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	const content = change.document.getText();
	const matches = content.matchAll(/(?:var|def|class|trait|import)\s+(?<name>[a-zA-Z0-9_]+)\s*(?:;|{)/g);
	let symbols: CompletionItem[] = [];
	let foundSymbols: Map<string, boolean> = new Map();

	for (let match of matches) {
		let symbol = match.groups;

		if (symbol && !foundSymbols.has(symbol.name)) {
			symbols.push({
				label: symbol.name,
				kind: symbol.name.charAt(0) == symbol.name.charAt(0).toLowerCase() ? 
					CompletionItemKind.Variable : CompletionItemKind.Class,
				data: `known-${symbol.name}`
			});

			foundSymbols.set(symbol.name, true);
		}
	}

	knownSymbols = symbols;

	// validateTextDocument(change.document);
});

// async function validateTextDocument(textDocument: TextDocument): Promise<void> {
// 	// In this simple example we get the settings for every validate run.
// 	let settings = await getDocumentSettings(textDocument.uri);

// 	// The validator creates diagnostics for all uppercase words length 2 and more
// 	let text = textDocument.getText();
// 	let pattern = /\b[A-Z]{2,}\b/g;
// 	let m: RegExpExecArray | null;

// 	console.log(text);

// 	let problems = 0;
// 	let diagnostics: Diagnostic[] = [];
// 	while ((m = pattern.exec(text)) && problems < settings.maxNumberOfProblems) {
// 		problems++;
// 		let diagnostic: Diagnostic = {
// 			severity: DiagnosticSeverity.Warning,
// 			range: {
// 				start: textDocument.positionAt(m.index),
// 				end: textDocument.positionAt(m.index + m[0].length)
// 			},
// 			message: `${m[0]} is all uppercase.`,
// 			source: 'ex'
// 		};
// 		if (hasDiagnosticRelatedInformationCapability) {
// 			diagnostic.relatedInformation = [
// 				{
// 					location: {
// 						uri: textDocument.uri,
// 						range: Object.assign({}, diagnostic.range)
// 					},
// 					message: 'Spelling matters'
// 				},
// 				{
// 					location: {
// 						uri: textDocument.uri,
// 						range: Object.assign({}, diagnostic.range)
// 					},
// 					message: 'Particularly for names'
// 				}
// 			];
// 		}
// 		diagnostics.push(diagnostic);
// 	}

// 	// Send the computed diagnostics to VSCode.
// 	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
// }

// connection.onDidChangeWatchedFiles(_change => {
// 	// Monitored files have change in VSCode
// 	connection.console.log('We received an file change event');
// });

// TODO: Re-make
function getPreviousToken(srcline: string, end: number) {
	let re = new RegExp("[$_a-zA-Z][$_a-zA-Z0-9]*", 'g');
	let found;
	while ((found = re.exec(srcline)) != null) {
		let last = found.index + found[0].length;
		if (last == end) {
			return found[0];
		}
	}
	return "";
}

function findModuleMethods(name: string): string[] {
	for (let module of builtInModules) {
		if (module.name == name) {
			return module.methods;
		}
	}

	return [];
}

// This handler provides the initial list of the completion items.
connection.onCompletion(
	(document: CompletionParams): CompletionItem[] => {
		const content = documents.get(document.textDocument.uri)?.getText().split("\n")[document.position.line];
		const position = document.position.character - 1;

		if (content === undefined) {
			return [];
		}

		switch (document.context?.triggerCharacter) {
			case ".": {
				const previousToken: string = getPreviousToken(content, position);
				const builtInMethods: string[] = findModuleMethods(previousToken);

				if (builtInMethods) {
					return builtInMethods.map((method) => ({
						label: method,
						kind: CompletionItemKind.Method,
						data: method
					}));
				}

				return [];
			}

			default: {
				if (content.slice(position - 7, position - 1) === "import") {
					let modules = [];

					for (let module of builtInModules) {
						modules.push({
							label: module.name,
							kind: CompletionItemKind.Module,
							data: module
						});
					}

					return modules;
				}

				let defaultCompletion: CompletionItem[] = [];

				for (let keyword of keywords) {
					defaultCompletion.push({
						label: keyword,
						kind: CompletionItemKind.Keyword,
						data: keyword
					});
				}

				for (let builtIn of builtIns) {
					defaultCompletion.push({
						label: builtIn,
						kind: CompletionItemKind.Function,
						data: `builtins-${builtIn}`
					});
				}

				for (let snippet in snippets) {
					const start: Position = Position.create(document.position.line, document.position.character - 1);
					const range = Range.create(start, document.position);
					const textEdit = TextEdit.replace(range, snippets[snippet].content);
					const content: MarkupContent = {
						value: [
							"```dictu",
							snippets[snippet].content,
							"```"
						].join('\n').replace(/\$[0-9]/g, ""),
						kind: MarkupKind.Markdown
					}

					defaultCompletion.push({
						label: snippet,
						kind: CompletionItemKind.Snippet,
						data: `snippet-${snippet}`,
						insertTextFormat: InsertTextFormat.Snippet,
						textEdit: textEdit,
						detail: snippets[snippet].detail,
						documentation: content
					});
				}

				if (knownSymbols !== []) {
					defaultCompletion.push(...knownSymbols);
				}

				return defaultCompletion;
			}
		}
	}
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		const key: string = item.data;
		const explaination = resolveExplainations[key];

		if (explaination !== undefined) {
			const content: MarkupContent = {
				value: [
					"```dictu",
					explaination.documentation,
					"```"
				].join('\n'),
				kind: MarkupKind.Markdown
			}

			item.detail = explaination.detail;
			item.documentation = content;
		}

		return item;
	}
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
