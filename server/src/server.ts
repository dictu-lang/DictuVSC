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
	InsertTextFormat,
	Hover,
	HoverParams,
	SignatureHelp,
	SignatureHelpParams,
	SignatureInformation,
	ParameterInformation,
	DefinitionParams,
	Definition,
	Location
} from 'vscode-languageserver/node';

import dictuLanguage from './language.json';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

// Create a connection for the server, using Node's IPC as a transport.
let connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

interface BuiltIn {
	name: string;
	detail: string;
	documentation: string;
}

interface ModuleConstant {
	name: string;
	detail: string;
}

interface ModuleMethod {
	name: string;
	detail: string;
	documentation: string;
}

interface BuiltInModule {
	name: string;
	detail: string;
	documentation: string;
	methods: ModuleMethod[];
	constants?: ModuleConstant[];
}

interface TypeMethod {
	name: string;
	detail: string;
	documentation: string;
}

interface TypeMethods {
	[typeName: string]: TypeMethod[];
}

interface Snippets {
	[key: string]: {
		content: string;
		detail: string;
	};
}

const keywords: string[] = dictuLanguage.keywords;
const builtIns: BuiltIn[] = dictuLanguage.builtins;
const builtInModules: BuiltInModule[] = dictuLanguage.modules;
const snippets: Snippets = dictuLanguage.snippets;
const typeMethods: TypeMethods = dictuLanguage.typeMethods;

let knownSymbols: CompletionItem[] = [];

// ============================================================
// Symbol definition tracking for Go to Definition
// ============================================================

interface SymbolDefinition {
	name: string;
	kind: string; // 'var' | 'const' | 'def' | 'class' | 'trait' | 'enum' | 'import'
	uri: string;
	line: number;
	startChar: number;
	endChar: number;
}

// Maps document URI -> array of symbol definitions in that document
const documentSymbols: Map<string, SymbolDefinition[]> = new Map();

// Flattened index: symbol name -> array of definitions (across all docs)
function getAllDefinitions(name: string): SymbolDefinition[] {
	const results: SymbolDefinition[] = [];
	for (const [_uri, symbols] of documentSymbols) {
		for (const sym of symbols) {
			if (sym.name === name) {
				results.push(sym);
			}
		}
	}
	return results;
}

/**
 * Parse a document and extract all symbol definitions with their locations.
 * Tracks: var, const, def, class, trait, enum, import...as, from...import,
 * init params (var/private in init), and method definitions inside classes.
 */
function parseDocumentSymbols(doc: TextDocument): SymbolDefinition[] {
	const content = doc.getText();
	const uri = doc.uri;
	const symbols: SymbolDefinition[] = [];
	const seen = new Set<string>();

	// Pattern for top-level and nested declarations:
	// var/const/def/class/trait/enum/import/as + identifier
	const declRegex = /\b(var|const|def|class|trait|enum|import|as)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
	let match;
	while ((match = declRegex.exec(content)) !== null) {
		const name = match[2];
		const offset = match.index + match[0].length - name.length;
		const pos = doc.positionAt(offset);
		const key = `${name}:${pos.line}`;
		if (!seen.has(key)) {
			seen.add(key);
			symbols.push({
				name,
				kind: match[1],
				uri,
				line: pos.line,
				startChar: pos.character,
				endChar: pos.character + name.length
			});
		}
	}

	// from Module import name1, name2 ...
	const fromImportRegex = /\bfrom\s+[a-zA-Z_][a-zA-Z0-9_]*\s+import\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*)*)/g;
	while ((match = fromImportRegex.exec(content)) !== null) {
		const names = match[1].split(',');
		// We need to find each name's offset in the source
		let searchStart = match.index;
		for (const rawName of names) {
			const name = rawName.trim();
			const nameIdx = content.indexOf(name, searchStart);
			if (nameIdx >= 0) {
				const pos = doc.positionAt(nameIdx);
				const key = `${name}:${pos.line}`;
				if (!seen.has(key)) {
					seen.add(key);
					symbols.push({
						name,
						kind: 'import',
						uri,
						line: pos.line,
						startChar: pos.character,
						endChar: pos.character + name.length
					});
				}
				searchStart = nameIdx + name.length;
			}
		}
	}

	// Method definitions inside classes (not preceded by 'def' keyword — init, toString, etc.)
	// Catch: identifier followed by ( at start of line or after whitespace in a class body context
	const methodRegex = /^\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm;
	while ((match = methodRegex.exec(content)) !== null) {
		const name = match[1];
		// Skip keywords and already-captured defs
		if (keywords.includes(name) || name === 'if' || name === 'while' || name === 'for' || name === 'switch' || name === 'return') {
			continue;
		}
		const offset = match.index + match[0].indexOf(name);
		const pos = doc.positionAt(offset);
		const key = `${name}:${pos.line}`;
		if (!seen.has(key)) {
			seen.add(key);
			symbols.push({
				name,
				kind: 'def',
				uri,
				line: pos.line,
				startChar: pos.character,
				endChar: pos.character + name.length
			});
		}
	}

	return symbols;
}

// ============================================================
// Build a lookup map for all hover-able items
// ============================================================

interface HoverInfo {
	detail: string;
	documentation: string;
}

const hoverMap: Map<string, HoverInfo> = new Map();

// Index builtins for hover
for (const builtin of builtIns) {
	hoverMap.set(builtin.name, { detail: `(builtin) ${builtin.name}`, documentation: builtin.documentation });
}

// Index modules for hover
for (const mod of builtInModules) {
	hoverMap.set(mod.name, { detail: `(module) ${mod.name}`, documentation: mod.detail });
	for (const method of mod.methods) {
		hoverMap.set(`${mod.name}.${method.name}`, { detail: `${mod.name}.${method.name}`, documentation: `${method.detail}\n\n${method.documentation}` });
	}
	if (mod.constants) {
		for (const constant of mod.constants) {
			hoverMap.set(`${mod.name}.${constant.name}`, { detail: `(constant) ${mod.name}.${constant.name}`, documentation: constant.detail });
		}
	}
}

// Index keywords for hover
const keywordDocs: { [key: string]: string } = {
	'var': 'Declare a mutable variable.\n\nvar x = 10;',
	'const': 'Declare an immutable constant.\n\nconst PI = 3.14;',
	'def': 'Define a function.\n\ndef myFunc(a, b) {\n    return a + b;\n}',
	'class': 'Define a class.\n\nclass Animal {\n    init(var name) {}\n}',
	'abstract': 'Declare an abstract class or method.\n\nabstract class Shape {\n    abstract area();\n}',
	'trait': 'Define a trait for mixin behavior.\n\ntrait Swimmable {\n    swim() { return "swimming"; }\n}',
	'enum': 'Define an enumeration.\n\nenum Direction {\n    North,\n    South,\n    East,\n    West\n}',
	'import': 'Import a module.\n\nimport Math;\nimport "file.du";',
	'from': 'Selective import from a module.\n\nfrom Math import pi;',
	'if': 'Conditional statement.\n\nif (condition) {\n    // ...\n}',
	'else': 'Else clause for conditional.\n\nif (x) {\n    // ...\n} else {\n    // ...\n}',
	'for': 'For loop.\n\nfor (var i = 0; i < 10; i += 1) {\n    // ...\n}',
	'while': 'While loop. Omit condition for infinite loop.\n\nwhile (condition) { }\nwhile { } // infinite',
	'switch': 'Switch statement.\n\nswitch (value) {\n    case 1: { }\n    default: { }\n}',
	'return': 'Return a value from a function.\n\nreturn value;',
	'with': 'File handling statement.\n\nwith("file.txt", "r") {\n    var content = file.read();\n}',
	'and': 'Logical AND operator.',
	'or': 'Logical OR operator.',
	'not': 'Logical NOT operator.',
	'true': 'Boolean true literal.',
	'false': 'Boolean false literal.',
	'nil': 'Nil value (absence of a value).',
	'this': 'Reference to the current instance inside a class.',
	'super': 'Reference to the parent class.',
	'static': 'Declare a static class method.\n\nstatic myMethod() { }',
	'private': 'Declare a private class method or property.\n\nprivate secretMethod() { }',
	'use': 'Include a trait in a class.\n\nclass Duck < Animal {\n    use Swimmable;\n}',
	'break': 'Break out of a loop.',
	'continue': 'Skip to the next iteration of a loop.',
	'as': 'Alias for imports.\n\nimport "file.du" as MyModule;',
	'case': 'Case label in a switch statement.',
	'default': 'Default label in a switch statement.'
};

for (const kw of keywords) {
	if (keywordDocs[kw]) {
		hoverMap.set(kw, { detail: `(keyword) ${kw}`, documentation: keywordDocs[kw] });
	}
}

// ============================================================
// Initialization
// ============================================================

connection.onInitialize((params: InitializeParams) => {
	let capabilities = params.capabilities;

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
			completionProvider: {
				triggerCharacters: ['.'],
				resolveProvider: false
			},
			hoverProvider: true,
			signatureHelpProvider: {
				triggerCharacters: ['(', ',']
			},
			definitionProvider: true
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
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

// ============================================================
// Settings
// ============================================================

interface DictuSettings {
	maxNumberOfProblems: number;
}

const defaultSettings: DictuSettings = { maxNumberOfProblems: 1000 };
let globalSettings: DictuSettings = defaultSettings;

let documentSettings: Map<string, Thenable<DictuSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		documentSettings.clear();
	} else {
		globalSettings = <DictuSettings>(
			(change.settings.dictuLanguageServer || defaultSettings)
		);
	}
});

documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
	documentSymbols.delete(e.document.uri);
});

// ============================================================
// Document change: parse symbols + update completion list
// ============================================================

interface SymbolInfo {
	name: string;
	kind: CompletionItemKind;
	type?: string;
}

let knownSymbolInfos: SymbolInfo[] = [];

documents.onDidChangeContent(change => {
	const doc = change.document;
	const content = doc.getText();

	// ---- Parse symbol definitions for Go to Definition ----
	const defs = parseDocumentSymbols(doc);
	documentSymbols.set(doc.uri, defs);

	// ---- Build completion symbols (same as before) ----
	const matches = content.matchAll(/(?<type>var|const|def|class|trait|enum|import|as)\s+(?<name>[a-zA-Z_][a-zA-Z0-9_]*)/g);
	let symbols: CompletionItem[] = [];
	let symbolInfos: SymbolInfo[] = [];
	let foundSymbols: Map<string, boolean> = new Map();

	for (let match of matches) {
		let symbol = match.groups;

		if (symbol && !foundSymbols.has(symbol.name)) {
			let kind: CompletionItemKind;
			let type: string | undefined;

			switch (symbol.type) {
				case 'import': {
					kind = CompletionItemKind.Module;
					type = 'module';
					break;
				}
				case 'trait': {
					kind = CompletionItemKind.Interface;
					type = 'trait';
					break;
				}
				case 'class': {
					kind = CompletionItemKind.Class;
					type = 'class';
					break;
				}
				case 'enum': {
					kind = CompletionItemKind.Enum;
					type = 'enum';
					break;
				}
				case 'def': {
					kind = CompletionItemKind.Function;
					type = 'function';
					break;
				}
				case 'const': {
					kind = CompletionItemKind.Constant;
					type = 'constant';
					break;
				}
				default: {
					kind = CompletionItemKind.Variable;
					type = 'variable';
				}
			}

			symbols.push({
				label: symbol.name,
				kind: kind,
			});

			symbolInfos.push({
				name: symbol.name,
				kind: kind,
				type: type
			});

			foundSymbols.set(symbol.name, true);
		}
	}

	knownSymbols = symbols;
	knownSymbolInfos = symbolInfos;
});

// ============================================================
// Helper functions
// ============================================================

function getPreviousToken(srcline: string, end: number): string {
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

function findModuleMethods(name: string): ModuleMethod[] {
	for (let module of builtInModules) {
		if (module.name == name) {
			return module.methods;
		}
	}
	return [];
}

function findModuleConstants(name: string): ModuleConstant[] {
	for (let module of builtInModules) {
		if (module.name == name && module.constants) {
			return module.constants;
		}
	}
	return [];
}

function getTypeFromContext(content: string, position: number, line: string): string | null {
	const beforeDot = line.substring(0, position).trim();

	if (beforeDot.endsWith("'") || beforeDot.endsWith('"')) {
		return 'string';
	}
	if (beforeDot.endsWith(']')) {
		return 'list';
	}
	if (beforeDot.endsWith('}')) {
		const trimmed = beforeDot.slice(0, -1).trim();
		if (trimmed.includes(':')) {
			return 'dict';
		}
	}
	if (/\d$/.test(beforeDot) && !beforeDot.endsWith('.')) {
		return 'number';
	}

	return null;
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

function buildTypeMethodCompletions(typeName: string): CompletionItem[] {
	const methods = typeMethods[typeName];
	if (!methods) return [];

	return methods.map((method) => ({
		label: method.name,
		kind: CompletionItemKind.Method,
		detail: `(${typeName} method) ${method.name}`,
		documentation: dictuDocumentationMarkdown(method.documentation)
	}));
}

/**
 * Extract the word under the cursor from a line at a given character position.
 * Returns { word, wordStart, wordEnd }.
 */
function getWordAtPosition(line: string, charPos: number): { word: string; wordStart: number; wordEnd: number } {
	let wordStart = charPos;
	let wordEnd = charPos;
	while (wordStart > 0 && /[a-zA-Z0-9_]/.test(line[wordStart - 1])) {
		wordStart--;
	}
	while (wordEnd < line.length && /[a-zA-Z0-9_]/.test(line[wordEnd])) {
		wordEnd++;
	}
	return { word: line.substring(wordStart, wordEnd), wordStart, wordEnd };
}

// ============================================================
// Go to Definition
// ============================================================

connection.onDefinition(
	(params: DefinitionParams): Definition | null => {
		const textDoc = documents.get(params.textDocument.uri);
		if (!textDoc) return null;

		const lines = textDoc.getText().split("\n");
		const line = lines[params.position.line];
		if (!line) return null;

		const { word, wordStart, wordEnd } = getWordAtPosition(line, params.position.character);
		if (!word || word.length === 0) return null;

		// Don't navigate for keywords, builtins are fine since user may want to see module definition
		if (keywords.includes(word)) return null;

		// Check for import "path.du" — resolve the import path
		// Pattern: import "some/path.du"  or  import "some/path.du" as X
		const importPathMatch = line.match(/\bimport\s+["']([^"']+)["']/);
		if (importPathMatch) {
			const importPath = importPathMatch[1];
			// If the cursor is on the string or the alias, try to resolve
			// We'll attempt to resolve relative to the current document
			const currentUri = params.textDocument.uri;
			let resolvedUri: string | null = null;

			if (currentUri.startsWith('file://')) {
				const currentPath = currentUri.replace('file://', '');
				const dir = currentPath.substring(0, currentPath.lastIndexOf('/'));
				let targetPath = importPath;
				if (!targetPath.endsWith('.du')) {
					targetPath += '.du';
				}
				if (!targetPath.startsWith('/')) {
					targetPath = dir + '/' + targetPath;
				}
				resolvedUri = 'file://' + targetPath;
			}

			if (resolvedUri) {
				return Location.create(resolvedUri, Range.create(0, 0, 0, 0));
			}
		}

		// Look for from "path.du" import X  — resolve the file path if cursor is on X
		const fromPathMatch = line.match(/\bfrom\s+["']([^"']+)["']\s+import\b/);
		if (fromPathMatch) {
			// Check if cursor is on one of the imported names
			const importListStart = line.indexOf('import', line.indexOf(fromPathMatch[0])) + 'import'.length;
			if (params.position.character >= importListStart) {
				// Cursor is in the imported names area — resolve to the file
				const importPath = fromPathMatch[1];
				const currentUri = params.textDocument.uri;
				if (currentUri.startsWith('file://')) {
					const currentPath = currentUri.replace('file://', '');
					const dir = currentPath.substring(0, currentPath.lastIndexOf('/'));
					let targetPath = importPath;
					if (!targetPath.endsWith('.du')) {
						targetPath += '.du';
					}
					if (!targetPath.startsWith('/')) {
						targetPath = dir + '/' + targetPath;
					}
					const resolvedUri = 'file://' + targetPath;

					// Try to find the specific symbol in the target file
					const targetDoc = documents.get(resolvedUri);
					if (targetDoc) {
						const targetSymbols = documentSymbols.get(resolvedUri) || [];
						for (const sym of targetSymbols) {
							if (sym.name === word) {
								return Location.create(sym.uri, Range.create(
									sym.line, sym.startChar,
									sym.line, sym.endChar
								));
							}
						}
					}

					// Fall back to top of file
					return Location.create(resolvedUri, Range.create(0, 0, 0, 0));
				}
			}
		}

		// Look up all definitions of the word across all open documents
		const defs = getAllDefinitions(word);
		if (defs.length > 0) {
			// Filter: prefer definitions that are NOT the current usage position
			const nonSelfDefs = defs.filter(d =>
				!(d.uri === params.textDocument.uri &&
				  d.line === params.position.line &&
				  d.startChar === wordStart)
			);

			const targets = nonSelfDefs.length > 0 ? nonSelfDefs : defs;

			if (targets.length === 1) {
				const d = targets[0];
				return Location.create(d.uri, Range.create(
					d.line, d.startChar,
					d.line, d.endChar
				));
			}

			// Multiple definitions: return all, VS Code will show a peek list
			return targets.map(d => Location.create(d.uri, Range.create(
				d.line, d.startChar,
				d.line, d.endChar
			)));
		}

		return null;
	}
);

// ============================================================
// Completion handler
// ============================================================

connection.onCompletion(
	(document: CompletionParams): CompletionItem[] => {
		const textDoc = documents.get(document.textDocument.uri);
		if (!textDoc) return [];

		const content = textDoc.getText();
		const lines = content.split("\n");
		const line = lines[document.position.line];
		const position = document.position.character - 1;

		if (line === undefined) {
			return [];
		}

		switch (document.context?.triggerCharacter) {
			case ".": {
				const previousToken: string = getPreviousToken(line, position);

				// Check built-in modules first
				const builtInMethods: ModuleMethod[] = findModuleMethods(previousToken);
				const builtInConstants: ModuleConstant[] = findModuleConstants(previousToken);

				if (builtInMethods.length > 0 || builtInConstants.length > 0) {
					let items: CompletionItem[] = [];

					items.push(...builtInMethods.map((method) => ({
						label: method.name,
						kind: CompletionItemKind.Method,
						data: method.name,
						detail: method.detail,
						documentation: dictuDocumentationMarkdown(method.documentation)
					})));

					items.push(...builtInConstants.map((constant) => ({
						label: constant.name,
						kind: CompletionItemKind.Constant,
						detail: constant.detail
					})));

					return items;
				}

				// Check if it's a type method context
				const inferredType = getTypeFromContext(content, position, line);
				if (inferredType) {
					return buildTypeMethodCompletions(inferredType);
				}

				// For any dot access, provide all type methods as suggestions
				let allMethods: CompletionItem[] = [];

				for (const typeName of Object.keys(typeMethods)) {
					const methods = typeMethods[typeName];
					for (const method of methods) {
						if (!allMethods.find(m => m.label === method.name)) {
							allMethods.push({
								label: method.name,
								kind: CompletionItemKind.Method,
								detail: method.detail,
								documentation: dictuDocumentationMarkdown(method.documentation)
							});
						}
					}
				}

				return allMethods;
			}

			default: {
				// Check if we're in an import context
				if (line.slice(Math.max(0, position - 7), position + 1).includes("import")) {
					let modules: CompletionItem[] = [];

					for (let module of builtInModules) {
						modules.push({
							label: module.name,
							kind: CompletionItemKind.Module,
							detail: module.detail,
							documentation: dictuDocumentationMarkdown(module.documentation)
						});
					}

					return modules;
				}

				let defaultCompletion: CompletionItem[] = [];

				// Keywords
				for (let keyword of keywords) {
					defaultCompletion.push({
						label: keyword,
						kind: CompletionItemKind.Keyword
					});
				}

				// Built-in functions
				for (let builtIn of builtIns) {
					defaultCompletion.push({
						label: builtIn.name,
						kind: CompletionItemKind.Function,
						detail: builtIn.detail,
						documentation: dictuDocumentationMarkdown(builtIn.documentation)
					});
				}

				// Modules
				for (let module of builtInModules) {
					defaultCompletion.push({
						label: module.name,
						kind: CompletionItemKind.Module,
						detail: module.detail,
						documentation: dictuDocumentationMarkdown(module.documentation)
					});
				}

				// Snippets
				for (let snippet in snippets) {
					const start: Position = Position.create(document.position.line, document.position.character - 1);
					const range = Range.create(start, document.position);
					const textEdit = TextEdit.replace(range, snippets[snippet].content);
					const docContent: MarkupContent = {
						value: [
							"```dictu",
							snippets[snippet].content,
							"```"
						].join('\n').replace(/\$\{?\d+(?::([^}]*))?\}?/g, "$1"),
						kind: MarkupKind.Markdown
					};

					defaultCompletion.push({
						label: snippet,
						kind: CompletionItemKind.Snippet,
						insertTextFormat: InsertTextFormat.Snippet,
						textEdit: textEdit,
						detail: snippets[snippet].detail,
						documentation: docContent
					});
				}

				// User-defined symbols
				if (knownSymbols.length > 0) {
					defaultCompletion.push(...knownSymbols);
				}

				return defaultCompletion;
			}
		}
	}
);

// ============================================================
// Hover handler
// ============================================================

connection.onHover(
	(params: HoverParams): Hover | null => {
		const textDoc = documents.get(params.textDocument.uri);
		if (!textDoc) return null;

		const content = textDoc.getText();
		const lines = content.split("\n");
		const line = lines[params.position.line];
		if (!line) return null;

		const { word, wordStart, wordEnd } = getWordAtPosition(line, params.position.character);
		if (!word) return null;

		// Check for Module.method pattern
		let fullToken = word;
		if (wordStart > 0 && line[wordStart - 1] === '.') {
			let moduleEnd = wordStart - 1;
			let moduleStart = moduleEnd;
			while (moduleStart > 0 && /[a-zA-Z0-9_]/.test(line[moduleStart - 1])) {
				moduleStart--;
			}
			const moduleName = line.substring(moduleStart, moduleEnd);
			if (moduleName) {
				fullToken = `${moduleName}.${word}`;
			}
		}

		// Look up in hover map (builtins, modules, keywords)
		const info = hoverMap.get(fullToken) || hoverMap.get(word);
		if (info) {
			const markdown: MarkupContent = {
				kind: MarkupKind.Markdown,
				value: `**${info.detail}**\n\n\`\`\`dictu\n${info.documentation}\n\`\`\``
			};
			return {
				contents: markdown,
				range: Range.create(
					Position.create(params.position.line, wordStart),
					Position.create(params.position.line, wordEnd)
				)
			};
		}

		// Check type methods for hover
		for (const typeName of Object.keys(typeMethods)) {
			const methods = typeMethods[typeName];
			for (const method of methods) {
				if (method.name === word) {
					const markdown: MarkupContent = {
						kind: MarkupKind.Markdown,
						value: `**(${typeName} method) ${method.name}**\n\n${method.detail}\n\n\`\`\`dictu\n${method.documentation}\n\`\`\``
					};
					return {
						contents: markdown,
						range: Range.create(
							Position.create(params.position.line, wordStart),
							Position.create(params.position.line, wordEnd)
						)
					};
				}
			}
		}

		// Show hover for user-defined symbols
		const defs = getAllDefinitions(word);
		if (defs.length > 0) {
			const d = defs[0];
			const kindLabel = d.kind === 'def' ? 'function' : d.kind;
			const markdown: MarkupContent = {
				kind: MarkupKind.Markdown,
				value: `**(${kindLabel})** \`${word}\``
			};
			return {
				contents: markdown,
				range: Range.create(
					Position.create(params.position.line, wordStart),
					Position.create(params.position.line, wordEnd)
				)
			};
		}

		return null;
	}
);

// ============================================================
// Signature help handler
// ============================================================

connection.onSignatureHelp(
	(params: SignatureHelpParams): SignatureHelp | null => {
		const textDoc = documents.get(params.textDocument.uri);
		if (!textDoc) return null;

		const lines = textDoc.getText().split("\n");
		const line = lines[params.position.line];
		if (!line) return null;

		const pos = params.position.character;

		let parenDepth = 0;
		let funcEnd = -1;
		let activeParam = 0;

		for (let i = pos - 1; i >= 0; i--) {
			const ch = line[i];
			if (ch === ')') parenDepth++;
			else if (ch === '(') {
				if (parenDepth === 0) {
					funcEnd = i;
					break;
				}
				parenDepth--;
			} else if (ch === ',' && parenDepth === 0) {
				activeParam++;
			}
		}

		if (funcEnd < 0) return null;

		let funcStart = funcEnd;
		while (funcStart > 0 && /[a-zA-Z0-9_.]/.test(line[funcStart - 1])) {
			funcStart--;
		}
		const funcName = line.substring(funcStart, funcEnd);
		if (!funcName) return null;

		// Look up in builtins
		for (const builtin of builtIns) {
			if (builtin.name === funcName) {
				const sig: SignatureInformation = {
					label: `${builtin.name}(...)`,
					documentation: {
						kind: MarkupKind.Markdown,
						value: builtin.detail
					} as MarkupContent
				};
				return {
					signatures: [sig],
					activeSignature: 0,
					activeParameter: activeParam
				};
			}
		}

		// Look up module methods (e.g., Math.min)
		const parts = funcName.split('.');
		if (parts.length === 2) {
			const methods = findModuleMethods(parts[0]);
			for (const method of methods) {
				if (method.name === parts[1]) {
					const sig: SignatureInformation = {
						label: `${funcName}(...)`,
						documentation: {
							kind: MarkupKind.Markdown,
							value: `${method.detail}\n\n\`\`\`dictu\n${method.documentation}\n\`\`\``
						} as MarkupContent
					};
					return {
						signatures: [sig],
						activeSignature: 0,
						activeParameter: activeParam
					};
				}
			}
		}

		return null;
	}
);

// Make the text document manager listen on the connection
documents.listen(connection);

// Listen on the connection
connection.listen();
