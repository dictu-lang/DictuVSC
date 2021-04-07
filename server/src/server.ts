/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
	createConnection,
	TextDocuments,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
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

interface BuiltIns {
	name: string,
	detail: string,
	documentation: string
}

interface BuiltinModuleMethods {
	name: string,
	detail: string,
	documentation: string
}

const keywords: string[] = dictuLanguage.keywords;
const builtIns: BuiltIns[] = dictuLanguage.builtins;
const builtInModules: {name: string; methods: BuiltinModuleMethods[]}[] = dictuLanguage.modules;
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
				triggerCharacters: ['.']
			}
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
	const matches = content.matchAll(/(?<type>var|const|def|class|trait|import)\s+(?<name>[a-zA-Z0-9_]+)\s*(?:|{)/g);
	let symbols: CompletionItem[] = [];
	let foundSymbols: Map<string, boolean> = new Map();

	for (let match of matches) {
		let symbol = match.groups;

		if (symbol && !foundSymbols.has(symbol.name)) {
			let kind;

			switch (symbol.type) {
				case 'import': {
					kind = CompletionItemKind.Module;
					break;
				}

				case 'trait':
				case 'class': {
					kind = CompletionItemKind.Class;
					break;
				}

				case 'def': {
					kind = CompletionItemKind.Function;
					break;
				}

				case 'const': {
					kind = CompletionItemKind.Constant;
					break;
				}

				default: {
					kind = CompletionItemKind.Variable;
				}
			}

			symbols.push({
				label: symbol.name,
				kind: kind,
				data: `known-${symbol.name}`,
			});

			foundSymbols.set(symbol.name, true);
		}
	}

	knownSymbols = symbols;
});

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

function findModuleMethods(name: string): BuiltinModuleMethods[] {
	for (let module of builtInModules) {
		if (module.name == name) {
			return module.methods;
		}
	}

	return [];
}

function dictuDocumentationMarkdown(documentation: string): MarkupContent {
	return {
		kind: MarkupKind.Markdown,
		value: [
			"```dictu",
			documentation,
			"```"
		].join('\n')
	};
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
				const builtInMethods: BuiltinModuleMethods[] = findModuleMethods(previousToken);

				if (builtInMethods) {
					return builtInMethods.map((method) => ({
						label: method.name,
						kind: CompletionItemKind.Method,
						data: method.name,
						detail: method.detail,
						documentation: dictuDocumentationMarkdown(method.documentation)
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
						label: builtIn.name,
						kind: CompletionItemKind.Function,
						data: builtIn.name,
						detail: builtIn.detail,
						documentation: dictuDocumentationMarkdown(builtIn.documentation)
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

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
