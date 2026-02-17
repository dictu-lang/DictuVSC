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
	Location,
	ReferenceParams,
	DocumentHighlightParams,
	DocumentHighlight,
	DocumentHighlightKind,
	DocumentSymbolParams,
	DocumentSymbol,
	SymbolKind,
	WorkspaceSymbolParams,
	SymbolInformation,
	RenameParams,
	PrepareRenameParams,
	WorkspaceEdit,
	FoldingRangeParams,
	FoldingRange,
	FoldingRangeKind,
	DocumentFormattingParams,
	CodeActionParams,
	CodeAction,
	CodeActionKind,
	DocumentLinkParams,
	DocumentLink,
	Diagnostic,
	DiagnosticSeverity
} from 'vscode-languageserver/node';

import dictuLanguage from './language.json';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

// ============================================================
// Server setup
// ============================================================

let connection = createConnection(ProposedFeatures.all);
let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

// ============================================================
// Language data interfaces
// ============================================================

interface BuiltIn { name: string; detail: string; documentation: string; }
interface ModuleConstant { name: string; detail: string; }
interface ModuleMethod { name: string; detail: string; documentation: string; }
interface BuiltInModule { name: string; detail: string; documentation: string; methods: ModuleMethod[]; constants?: ModuleConstant[]; }
interface TypeMethod { name: string; detail: string; documentation: string; }
interface TypeMethods { [typeName: string]: TypeMethod[]; }
interface Snippets { [key: string]: { content: string; detail: string; }; }

const keywords: string[] = dictuLanguage.keywords;
const builtIns: BuiltIn[] = dictuLanguage.builtins;
const builtInModules: BuiltInModule[] = dictuLanguage.modules;
const snippets: Snippets = dictuLanguage.snippets;
const typeMethods: TypeMethods = dictuLanguage.typeMethods;

let knownSymbols: CompletionItem[] = [];

// ============================================================
// Type inference engine
// ============================================================

type DictuType = string | null;

/** Maps method names → return types, keyed by the receiver type */
const _mrt: Record<string, Record<string, DictuType>> = {};
function mrt(receiverType: string, methods: Record<string, DictuType>) { _mrt[receiverType] = methods; }
mrt('string', {
	len: 'number', lower: 'string', upper: 'string', title: 'string',
	toNumber: 'result', toBool: 'bool', toString: 'string',
	startsWith: 'bool', endsWith: 'bool', contains: 'bool',
	isUpper: 'bool', isLower: 'bool',
	split: 'list', replace: 'string', strip: 'string',
	leftStrip: 'string', rightStrip: 'string', format: 'string',
	find: 'number', findLast: 'number', count: 'number', wordCount: 'number',
	repeat: 'string', collapseSpaces: 'string', wrap: 'string',
});
mrt('number', { toString: 'string', toBool: 'bool' });
mrt('bool', { toString: 'string' });
mrt('nil', { toString: 'string', toBool: 'bool' });
mrt('list', {
	len: 'number', toString: 'string', toBool: 'bool',
	push: 'nil', insert: 'nil', extend: 'nil', remove: 'nil',
	pop: null, contains: 'bool', join: 'string',
	copy: 'list', deepCopy: 'list', sort: 'nil', sortFunc: 'nil', reverse: 'nil',
	map: 'list', filter: 'list', splice: 'list', unique: 'list',
	reduce: null, forEach: 'nil', find: null, findIndex: 'number',
});
mrt('dict', {
	len: 'number', toString: 'string', toBool: 'bool',
	keys: 'list', get: null, exists: 'bool', remove: 'nil',
	copy: 'dict', deepCopy: 'dict', forEach: 'nil', merge: 'dict',
	toObj: 'class',
});
mrt('set', {
	len: 'number', toString: 'string', toBool: 'bool',
	add: 'nil', remove: 'nil', contains: 'bool', containsAll: 'bool',
	values: 'list',
});
mrt('result', {
	unwrap: null, unwrapError: 'string', success: 'bool',
	match: null, matchWrap: 'result', matchError: null,
});
mrt('file', {
	read: 'string', readLine: 'string', write: 'number', writeLine: 'number', seek: 'nil',
});
mrt('class', {
	toString: 'string', toDict: 'dict', methods: 'list',
	hasAttribute: 'bool', getAttribute: null, getAttributes: 'dict',
	setAttribute: 'nil', isInstance: 'bool',
	copy: 'class', deepCopy: 'class',
});
const methodReturnTypes = _mrt;

/** Maps module.method → return type */
const moduleMethodReturnTypes: { [key: string]: DictuType } = {
	// Math
	'Math.min': 'number', 'Math.max': 'number', 'Math.average': 'number', 'Math.sum': 'number',
	'Math.floor': 'number', 'Math.ceil': 'number', 'Math.round': 'number', 'Math.abs': 'number',
	'Math.sqrt': 'number', 'Math.sin': 'number', 'Math.cos': 'number', 'Math.tan': 'number',
	'Math.gcd': 'number', 'Math.lcm': 'number',
	// System
	'System.getCWD': 'result', 'System.setCWD': 'result',
	'System.getpid': 'number', 'System.getppid': 'number',
	'System.getuid': 'number', 'System.geteuid': 'number',
	'System.getgid': 'number', 'System.getegid': 'number',
	'System.clock': 'number', 'System.time': 'number',
	'System.mkdir': 'result', 'System.mkdirAll': 'result', 'System.rmdir': 'result',
	'System.remove': 'result', 'System.rename': 'result',
	'System.mkdirTemp': 'result', 'System.chmod': 'result', 'System.chown': 'result',
	'System.uname': 'dict', 'System.sleep': 'nil', 'System.collect': 'nil', 'System.exit': 'nil',
	// Datetime
	'Datetime.now': 'string', 'Datetime.nowUTC': 'string',
	'Datetime.strftime': 'string', 'Datetime.strptime': 'number',
	// Path
	'Path.basename': 'string', 'Path.dirname': 'string', 'Path.extname': 'string',
	'Path.join': 'string', 'Path.realpath': 'result',
	'Path.isAbsolute': 'bool', 'Path.exists': 'bool', 'Path.isDir': 'bool', 'Path.isSymbolicLink': 'bool',
	'Path.listDir': 'list',
	// Env
	'Env.get': 'string', 'Env.set': 'result', 'Env.readFile': 'result',
	// JSON
	'JSON.parse': 'result', 'JSON.stringify': 'result',
	// HTTP
	'HTTP.get': 'result', 'HTTP.post': 'result', 'HTTP.put': 'result',
	'HTTP.head': 'result', 'HTTP.options': 'result',
	// Random
	'Random.random': 'number', 'Random.range': 'number', 'Random.select': null,
	// Base64
	'Base64.encode': 'string', 'Base64.decode': 'string',
	// Hashlib
	'Hashlib.sha256': 'string', 'Hashlib.hmac': 'string', 'Hashlib.bcrypt': 'string',
	'Hashlib.bcryptVerify': 'bool', 'Hashlib.verify': 'bool',
	// Process
	'Process.exec': 'result', 'Process.run': 'result', 'Process.kill': 'result',
	// IO
	'IO.print': 'nil', 'IO.println': 'nil', 'IO.eprint': 'nil', 'IO.eprintln': 'nil',
	'IO.copyFile': 'result',
	// Sqlite
	'Sqlite.connect': 'result',
	// Socket
	'Socket.create': 'result',
	// UUID
	'UUID.generate': 'result', 'UUID.generateRandom': 'result', 'UUID.generateTime': 'result',
	// Buffer
	'Buffer.new': 'result', 'Buffer.fromString': 'result',
	// Queue / Stack
	'Queue.new': null, 'Queue.newWithSize': 'result',
	'Stack.new': null, 'Stack.newWithSize': 'result',
	// BigInt
	'BigInt.new': 'result',
	// Log
	'Log.new': 'result', 'Log.print': 'nil', 'Log.println': 'nil',
	'Log.fatal': 'nil', 'Log.fatalln': 'nil',
	// Net
	'Net.parseIp4': 'result',
	// Object
	'Object.getClassRef': 'result', 'Object.createFrom': 'result',
	'Object.hash': 'string', 'Object.prettyPrint': 'nil',
	// Inspect
	'Inspect.getFrameCount': 'number', 'Inspect.getLine': 'number', 'Inspect.getFile': 'string',
	// Term
	'Term.isatty': 'bool', 'Term.getSize': 'list',
	// FFI
	'FFI.load': null,
	// Argparse
	'Argparse.Parser': null,
};

/** Maps module constants → types */
const moduleConstantTypes: { [key: string]: DictuType } = {
	'Math.pi': 'number', 'Math.e': 'number', 'Math.phi': 'number',
	'Math.sqrt2': 'number', 'Math.sqrte': 'number', 'Math.sqrtpi': 'number',
	'Math.sqrtphi': 'number', 'Math.ln2': 'number', 'Math.ln10': 'number',
	'System.argv': 'list', 'System.platform': 'string', 'System.arch': 'string',
	'System.version': 'string',
	'Datetime.SECONDS_IN_MINUTE': 'number', 'Datetime.SECONDS_IN_HOUR': 'number',
	'Datetime.SECONDS_IN_DAY': 'number', 'Datetime.SECONDS_IN_WEEK': 'number',
	'Path.delimiter': 'string', 'Path.dirSeparator': 'string',
	'IO.devNull': 'string',
	'Log.stdout': 'number', 'Log.stderr': 'number', 'Log.stdin': 'number',
	'FFI.suffix': 'string',
};

/** Maps builtin function names → return types */
const builtinReturnTypes: { [name: string]: DictuType } = {
	'print': 'nil', 'printError': 'nil', 'input': 'string',
	'type': 'string', 'assert': 'nil', 'isDefined': 'bool',
	'set': 'set', 'Success': 'result', 'Error': 'result',
};

/** Per-document variable type tracking: variable name → inferred type */
const documentVariableTypes: Map<string, Map<string, DictuType>> = new Map();

/** Module names for checking if a token is a known module */
const moduleNames = new Set(builtInModules.map(m => m.name));

/**
 * Parse all variable/const declarations in a document and infer their types
 * from the right-hand side expression.
 */
function parseVariableTypes(doc: TextDocument): Map<string, DictuType> {
	const types = new Map<string, DictuType>();
	const content = doc.getText();
	const lines = content.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// var name = expr; / const name = expr;
		const varMatch = line.match(/\b(?:var|const)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)/);
		if (varMatch) {
			const varName = varMatch[1];
			const rhs = varMatch[2].trim().replace(/;$/, '').trim();
			const t = inferExpressionType(rhs, types);
			if (t) types.set(varName, t);
			continue;
		}

		// def name — it's a function
		const defMatch = line.match(/\bdef\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
		if (defMatch) {
			types.set(defMatch[1], 'function');
			continue;
		}

		// class Name — it's a class
		const classMatch = line.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/);
		if (classMatch) {
			types.set(classMatch[1], 'class');
			continue;
		}

		// enum Name — it's an enum
		const enumMatch = line.match(/\benum\s+([A-Za-z_][A-Za-z0-9_]*)/);
		if (enumMatch) {
			types.set(enumMatch[1], 'enum');
			continue;
		}

		// trait Name — interface-like
		const traitMatch = line.match(/\btrait\s+([A-Za-z_][A-Za-z0-9_]*)/);
		if (traitMatch) {
			types.set(traitMatch[1], 'class');
			continue;
		}

		// import Module;
		const importMatch = line.match(/\bimport\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/);
		if (importMatch) {
			types.set(importMatch[1], 'module');
			continue;
		}

		// Reassignment: name = expr; (track latest type for var)
		const reassignMatch = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)/);
		if (reassignMatch) {
			const varName = reassignMatch[1];
			// Only update if it was already a known variable (not a new field assignment like this.x = ...)
			if (types.has(varName)) {
				const rhs = reassignMatch[2].trim().replace(/;$/, '').trim();
				const t = inferExpressionType(rhs, types);
				if (t) types.set(varName, t);
			}
		}
	}

	return types;
}

/**
 * Infer the type of an expression string.
 * This handles literals, function calls, method chains, and variable references.
 */
function inferExpressionType(expr: string, varTypes: Map<string, DictuType>): DictuType {
	expr = expr.trim();
	if (!expr) return null;

	// --- Literals ---
	// String literal
	if (/^r?["']/.test(expr)) return 'string';
	// Boolean
	if (expr === 'true' || expr === 'false') return 'bool';
	// Nil
	if (expr === 'nil') return 'nil';
	// Number (int, float, hex, with underscores)
	if (/^0[xX][0-9a-fA-F_]+$/.test(expr) || /^[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9]+)?$/.test(expr)) return 'number';
	// List literal
	if (expr.startsWith('[')) return 'list';
	// Dict literal — starts with { and has a colon
	if (expr.startsWith('{') && expr.includes(':')) return 'dict';
	// Set literal — starts with { without colon is ambiguous, but set() is the constructor
	if (/^set\s*\(/.test(expr)) return 'set';
	// Success/Error constructors
	if (/^Success\s*\(/.test(expr)) return 'result';
	if (/^Error\s*\(/.test(expr)) return 'result';

	// --- Builtin function calls ---
	const builtinCallMatch = expr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
	if (builtinCallMatch && builtinReturnTypes[builtinCallMatch[1]] !== undefined) {
		return builtinReturnTypes[builtinCallMatch[1]];
	}

	// --- Method chain / dot expressions: walk from left to right ---
	// We need to handle: Module.method(...), var.method(), literal.method().method(), etc.
	if (expr.includes('.')) {
		const resolvedType = resolveChainedType(expr, varTypes);
		if (resolvedType) return resolvedType;
	}

	// --- Simple variable reference ---
	const simpleVar = expr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)$/);
	if (simpleVar) {
		return varTypes.get(simpleVar[1]) || null;
	}

	// --- Constructor call: ClassName(...) where name starts with uppercase ---
	if (builtinCallMatch && /^[A-Z]/.test(builtinCallMatch[1]) && !moduleNames.has(builtinCallMatch[1])) {
		return 'class';
	}

	return null;
}

/**
 * Resolve the type of a chained dot expression by walking left to right.
 * E.g. "myList.map(fn).join(',')" → list → list → string
 */
function resolveChainedType(expr: string, varTypes: Map<string, DictuType>): DictuType {
	// Tokenize the chain, respecting parentheses and strings
	const segments = splitDotExpression(expr);
	if (segments.length === 0) return null;

	// Determine type of the first segment (the base)
	let currentType = inferBaseType(segments[0], varTypes);

	// Walk through remaining segments
	for (let i = 1; i < segments.length; i++) {
		if (!currentType) break;
		const seg = segments[i];
		const methodMatch = seg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
		const propMatch = seg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)$/);

		if (currentType === 'module' && i === 1) {
			// Module.method() or Module.constant
			const moduleName = segments[0].trim();
			if (methodMatch) {
				const key = `${moduleName}.${methodMatch[1]}`;
				currentType = moduleMethodReturnTypes[key] ?? null;
			} else if (propMatch) {
				const key = `${moduleName}.${propMatch[1]}`;
				currentType = moduleConstantTypes[key] ?? null;
			} else {
				currentType = null;
			}
		} else if (methodMatch) {
			// Type method: currentType.methodName(...)
			const methodName = methodMatch[1];
			const typeMap = methodReturnTypes[currentType];
			if (typeMap && methodName in typeMap) {
				currentType = typeMap[methodName];
			} else {
				currentType = null;
			}
		} else {
			// Property access — can't determine type
			currentType = null;
		}
	}

	return currentType;
}

/**
 * Infer the type of the first segment (base) of a dot expression.
 */
function inferBaseType(base: string, varTypes: Map<string, DictuType>): DictuType {
	base = base.trim();

	// String literal
	if (/^r?["']/.test(base) || /["']$/.test(base)) return 'string';
	// Number literal
	if (/^[0-9]/.test(base) || /^0[xX]/.test(base)) return 'number';
	// List literal
	if (base.startsWith('[') || base.endsWith(']')) return 'list';
	// Dict literal
	if (base.startsWith('{') || (base.endsWith('}') && base.includes(':'))) return 'dict';
	// Boolean
	if (base === 'true' || base === 'false') return 'bool';
	// Nil
	if (base === 'nil') return 'nil';
	// set()
	if (/^set\s*\(/.test(base)) return 'set';
	// Success/Error
	if (/^Success\s*\(/.test(base)) return 'result';
	if (/^Error\s*\(/.test(base)) return 'result';

	// Module name check
	if (moduleNames.has(base)) return 'module';

	// Function call — check builtins
	const callMatch = base.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
	if (callMatch) {
		if (builtinReturnTypes[callMatch[1]] !== undefined) return builtinReturnTypes[callMatch[1]];
		// Constructor with uppercase
		if (/^[A-Z]/.test(callMatch[1]) && !moduleNames.has(callMatch[1])) return 'class';
		// User-defined function — return type unknown
		return null;
	}

	// Parenthesized expression ending with )
	if (base.endsWith(')')) {
		// Could be (expr) or func(args) — try to extract inner
		return null;
	}

	// Variable reference
	const varType = varTypes.get(base);
	if (varType) return varType;

	// this/super → class
	if (base === 'this' || base === 'super') return 'class';

	return null;
}

/**
 * Split "a.b(x.y).c" into ["a", "b(x.y)", "c"] respecting parens, brackets, strings.
 */
function splitDotExpression(expr: string): string[] {
	const segments: string[] = [];
	let current = '';
	let depth = 0; // () and [] depth
	let inStr: string | null = null;

	for (let i = 0; i < expr.length; i++) {
		const ch = expr[i];

		if (inStr) {
			current += ch;
			if (ch === '\\' && i + 1 < expr.length) { current += expr[++i]; continue; }
			if (ch === inStr) inStr = null;
			continue;
		}

		if (ch === '"' || ch === "'") {
			inStr = ch;
			current += ch;
			continue;
		}

		if (ch === '(' || ch === '[' || ch === '{') { depth++; current += ch; continue; }
		if (ch === ')' || ch === ']' || ch === '}') { depth--; current += ch; continue; }

		if (ch === '.' && depth === 0) {
			if (current.trim()) segments.push(current.trim());
			current = '';
			continue;
		}

		current += ch;
	}
	if (current.trim()) segments.push(current.trim());
	return segments;
}

/**
 * Main entry: infer the type of the expression immediately before the dot
 * at the given position on the given line. Uses variable types for the document.
 */
function inferTypeBeforeDot(line: string, dotPosition: number, docUri: string): DictuType {
	const beforeDot = line.substring(0, dotPosition).trim();
	if (!beforeDot) return null;

	const varTypes = documentVariableTypes.get(docUri) || new Map();

	// Try full expression type resolution
	const expr = extractExpressionBeforeDot(beforeDot);
	return inferExpressionType(expr, varTypes);
}

/**
 * Extract the expression ending at the dot from the line prefix.
 * Walks backwards from the end, handling balanced parens/brackets/strings.
 */
function extractExpressionBeforeDot(text: string): string {
	let i = text.length - 1;
	let depth = 0;

	// Walk backwards to find the start of the expression
	while (i >= 0) {
		const ch = text[i];

		if (ch === ')' || ch === ']' || ch === '}') { depth++; i--; continue; }
		if (ch === '(' || ch === '[' || ch === '{') {
			if (depth > 0) { depth--; i--; continue; }
			break;
		}

		if (depth > 0) { i--; continue; }

		// String delimiters at the end
		if (ch === '"' || ch === "'") {
			// Walk back to find the matching opening quote
			const quote = ch;
			i--;
			while (i >= 0 && text[i] !== quote) {
				if (text[i] === '\\' && i > 0) i--; // skip escape
				i--;
			}
			// Check for raw string prefix
			if (i > 0 && text[i - 1] === 'r') i--;
			continue;
		}

		// Identifiers, digits, dots (for chains)
		if (/[a-zA-Z0-9_.]/.test(ch)) { i--; continue; }

		// Anything else (operator, space, comma, etc.) — stop
		i++;
		break;
	}

	if (i < 0) i = 0;
	return text.substring(i).trim();
}

// ============================================================
// Symbol definition tracking
// ============================================================

interface SymbolDefinition {
	name: string;
	kind: string;
	uri: string;
	line: number;
	startChar: number;
	endChar: number;
}

const documentSymbols: Map<string, SymbolDefinition[]> = new Map();

function getAllDefinitions(name: string): SymbolDefinition[] {
	const results: SymbolDefinition[] = [];
	for (const [, symbols] of documentSymbols) {
		for (const sym of symbols) {
			if (sym.name === name) results.push(sym);
		}
	}
	return results;
}

function parseDocumentSymbols(doc: TextDocument): SymbolDefinition[] {
	const content = doc.getText();
	const uri = doc.uri;
	const symbols: SymbolDefinition[] = [];
	const seen = new Set<string>();

	const declRegex = /\b(var|const|def|class|trait|enum|import|as)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
	let match;
	while ((match = declRegex.exec(content)) !== null) {
		const name = match[2];
		const offset = match.index + match[0].length - name.length;
		const pos = doc.positionAt(offset);
		const key = `${name}:${pos.line}:${pos.character}`;
		if (!seen.has(key)) {
			seen.add(key);
			symbols.push({ name, kind: match[1], uri, line: pos.line, startChar: pos.character, endChar: pos.character + name.length });
		}
	}

	const fromImportRegex = /\bfrom\s+[a-zA-Z_][a-zA-Z0-9_]*\s+import\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*)*)/g;
	while ((match = fromImportRegex.exec(content)) !== null) {
		const names = match[1].split(',');
		let searchStart = match.index;
		for (const rawName of names) {
			const name = rawName.trim();
			const nameIdx = content.indexOf(name, searchStart);
			if (nameIdx >= 0) {
				const pos = doc.positionAt(nameIdx);
				const key = `${name}:${pos.line}:${pos.character}`;
				if (!seen.has(key)) {
					seen.add(key);
					symbols.push({ name, kind: 'import', uri, line: pos.line, startChar: pos.character, endChar: pos.character + name.length });
				}
				searchStart = nameIdx + name.length;
			}
		}
	}

	const methodRegex = /^\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm;
	while ((match = methodRegex.exec(content)) !== null) {
		const name = match[1];
		if (keywords.includes(name)) continue;
		const offset = match.index + match[0].indexOf(name);
		const pos = doc.positionAt(offset);
		const key = `${name}:${pos.line}:${pos.character}`;
		if (!seen.has(key)) {
			seen.add(key);
			symbols.push({ name, kind: 'def', uri, line: pos.line, startChar: pos.character, endChar: pos.character + name.length });
		}
	}

	return symbols;
}

// ============================================================
// Hover map
// ============================================================

interface HoverInfo { detail: string; documentation: string; }
const hoverMap: Map<string, HoverInfo> = new Map();

for (const builtin of builtIns) {
	hoverMap.set(builtin.name, { detail: `(builtin) ${builtin.name}`, documentation: builtin.documentation });
}
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
	'and': 'Logical AND operator.', 'or': 'Logical OR operator.', 'not': 'Logical NOT operator.',
	'true': 'Boolean true literal.', 'false': 'Boolean false literal.', 'nil': 'Nil value (absence of a value).',
	'this': 'Reference to the current instance inside a class.', 'super': 'Reference to the parent class.',
	'static': 'Declare a static class method.\n\nstatic myMethod() { }',
	'private': 'Declare a private class method or property.\n\nprivate secretMethod() { }',
	'use': 'Include a trait in a class.\n\nclass Duck < Animal {\n    use Swimmable;\n}',
	'break': 'Break out of a loop.', 'continue': 'Skip to the next iteration of a loop.',
	'as': 'Alias for imports.\n\nimport "file.du" as MyModule;',
	'case': 'Case label in a switch statement.', 'default': 'Default label in a switch statement.'
};
for (const kw of keywords) {
	if (keywordDocs[kw]) hoverMap.set(kw, { detail: `(keyword) ${kw}`, documentation: keywordDocs[kw] });
}

// ============================================================
// Initialization
// ============================================================

connection.onInitialize((params: InitializeParams) => {
	let capabilities = params.capabilities;
	hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration);
	hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders);
	hasDiagnosticRelatedInformationCapability = !!(capabilities.textDocument && capabilities.textDocument.publishDiagnostics && capabilities.textDocument.publishDiagnostics.relatedInformation);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			completionProvider: { triggerCharacters: ['.'], resolveProvider: false },
			hoverProvider: true,
			signatureHelpProvider: { triggerCharacters: ['(', ','] },
			definitionProvider: true,
			referencesProvider: true,
			documentHighlightProvider: true,
			documentSymbolProvider: true,
			workspaceSymbolProvider: true,
			renameProvider: { prepareProvider: true },
			foldingRangeProvider: true,
			documentFormattingProvider: true,
			codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.Source] },
			documentLinkProvider: { resolveProvider: false }
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = { workspaceFolders: { supported: true } };
	}
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) connection.client.register(DidChangeConfigurationNotification.type, undefined);
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

// ============================================================
// Settings
// ============================================================

interface DictuSettings { maxNumberOfProblems: number; }
const defaultSettings: DictuSettings = { maxNumberOfProblems: 1000 };
let globalSettings: DictuSettings = defaultSettings;
let documentSettings: Map<string, Thenable<DictuSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) documentSettings.clear();
	else globalSettings = <DictuSettings>(change.settings.dictuLanguageServer || defaultSettings);
	documents.all().forEach(validateDocument);
});

documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
	documentSymbols.delete(e.document.uri);
	documentVariableTypes.delete(e.document.uri);
});

// ============================================================
// Document change: parse symbols + validate
// ============================================================

interface SymbolInfo { name: string; kind: CompletionItemKind; type?: string; }
let knownSymbolInfos: SymbolInfo[] = [];

documents.onDidChangeContent(change => {
	const doc = change.document;
	const content = doc.getText();

	const defs = parseDocumentSymbols(doc);
	documentSymbols.set(doc.uri, defs);

	// Parse and track variable types for this document
	const varTypes = parseVariableTypes(doc);
	documentVariableTypes.set(doc.uri, varTypes);

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
				case 'import': kind = CompletionItemKind.Module; type = 'module'; break;
				case 'trait': kind = CompletionItemKind.Interface; type = 'trait'; break;
				case 'class': kind = CompletionItemKind.Class; type = 'class'; break;
				case 'enum': kind = CompletionItemKind.Enum; type = 'enum'; break;
				case 'def': kind = CompletionItemKind.Function; type = 'function'; break;
				case 'const': kind = CompletionItemKind.Constant; type = 'constant'; break;
				default: kind = CompletionItemKind.Variable; type = 'variable';
			}
			symbols.push({ label: symbol.name, kind });
			symbolInfos.push({ name: symbol.name, kind, type });
			foundSymbols.set(symbol.name, true);
		}
	}
	knownSymbols = symbols;
	knownSymbolInfos = symbolInfos;

	validateDocument(doc);
});

// ============================================================
// Diagnostics — basic static checks
// ============================================================

function validateDocument(doc: TextDocument): void {
	const content = doc.getText();
	const lines = content.split('\n');
	const diagnostics: Diagnostic[] = [];

	// Check for mismatched braces/parens/brackets
	const stack: { char: string; line: number; col: number }[] = [];
	const openers: { [key: string]: string } = { '{': '}', '(': ')', '[': ']' };
	const closers: { [key: string]: string } = { '}': '{', ')': '(', ']': '[' };
	let inSingleLineComment = false;
	let inBlockComment = false;
	let inString: string | null = null;

	for (let lineNum = 0; lineNum < lines.length; lineNum++) {
		const line = lines[lineNum];
		inSingleLineComment = false;
		for (let col = 0; col < line.length; col++) {
			const ch = line[col];
			const prev = col > 0 ? line[col - 1] : '';

			if (inBlockComment) {
				if (ch === '/' && prev === '*') inBlockComment = false;
				continue;
			}
			if (inSingleLineComment) continue;
			if (inString) {
				if (ch === '\\') { col++; continue; }
				if (ch === inString) inString = null;
				continue;
			}
			if (ch === '/' && col + 1 < line.length && line[col + 1] === '/') { inSingleLineComment = true; continue; }
			if (ch === '/' && col + 1 < line.length && line[col + 1] === '*') { inBlockComment = true; col++; continue; }
			if (ch === '"' || ch === "'") { inString = ch; continue; }

			if (openers[ch]) {
				stack.push({ char: ch, line: lineNum, col });
			} else if (closers[ch]) {
				if (stack.length === 0 || stack[stack.length - 1].char !== closers[ch]) {
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						range: Range.create(lineNum, col, lineNum, col + 1),
						message: `Unexpected '${ch}'`,
						source: 'dictu'
					});
				} else {
					stack.pop();
				}
			}
		}
	}

	for (const unclosed of stack) {
		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			range: Range.create(unclosed.line, unclosed.col, unclosed.line, unclosed.col + 1),
			message: `Unclosed '${unclosed.char}'`,
			source: 'dictu'
		});
	}

	if (inBlockComment) {
		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			range: Range.create(lines.length - 1, 0, lines.length - 1, lines[lines.length - 1].length),
			message: 'Unterminated block comment',
			source: 'dictu'
		});
	}

	// Check for common mistakes
	for (let lineNum = 0; lineNum < lines.length; lineNum++) {
		const line = lines[lineNum];
		const trimmed = line.trim();

		// Skip comments and strings for these checks
		if (trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;

		// Warn on '= =' which should probably be '=='
		const doubleAssign = line.match(/[^=!<>]=\s+=(?!=)/);
		if (doubleAssign && doubleAssign.index !== undefined) {
			// Make sure we're not in a string
			const before = line.substring(0, doubleAssign.index);
			const singleQ = (before.match(/'/g) || []).length;
			const doubleQ = (before.match(/"/g) || []).length;
			if (singleQ % 2 === 0 && doubleQ % 2 === 0) {
				diagnostics.push({
					severity: DiagnosticSeverity.Warning,
					range: Range.create(lineNum, doubleAssign.index, lineNum, doubleAssign.index + doubleAssign[0].length),
					message: "Did you mean '==' instead of '= ='?",
					source: 'dictu'
				});
			}
		}
	}

	connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

// ============================================================
// Helpers
// ============================================================

function getPreviousToken(srcline: string, end: number): string {
	let re = /[$_a-zA-Z][$_a-zA-Z0-9]*/g;
	let found;
	while ((found = re.exec(srcline)) != null) {
		if (found.index + found[0].length == end) return found[0];
	}
	return "";
}

function findModuleMethods(name: string): ModuleMethod[] {
	for (let module of builtInModules) { if (module.name == name) return module.methods; }
	return [];
}

function findModuleConstants(name: string): ModuleConstant[] {
	for (let module of builtInModules) { if (module.name == name && module.constants) return module.constants; }
	return [];
}

// getTypeFromContext is now replaced by inferTypeBeforeDot (see type inference engine above)

function dictuDocumentationMarkdown(documentation: string): MarkupContent {
	return { kind: MarkupKind.Markdown, value: "```dictu\n" + documentation + "\n```" };
}

function buildTypeMethodCompletions(typeName: string): CompletionItem[] {
	const methods = typeMethods[typeName];
	if (!methods) return [];
	return methods.map((method) => ({
		label: method.name, kind: CompletionItemKind.Method,
		detail: `(${typeName} method) ${method.name}`,
		documentation: dictuDocumentationMarkdown(method.documentation)
	}));
}

function getWordAtPosition(line: string, charPos: number): { word: string; wordStart: number; wordEnd: number } {
	let wordStart = charPos;
	let wordEnd = charPos;
	while (wordStart > 0 && /[a-zA-Z0-9_]/.test(line[wordStart - 1])) wordStart--;
	while (wordEnd < line.length && /[a-zA-Z0-9_]/.test(line[wordEnd])) wordEnd++;
	return { word: line.substring(wordStart, wordEnd), wordStart, wordEnd };
}

function kindForSymbol(kind: string): SymbolKind {
	switch (kind) {
		case 'class': return SymbolKind.Class;
		case 'trait': return SymbolKind.Interface;
		case 'enum': return SymbolKind.Enum;
		case 'def': return SymbolKind.Function;
		case 'var': return SymbolKind.Variable;
		case 'const': return SymbolKind.Constant;
		case 'import': return SymbolKind.Module;
		default: return SymbolKind.Variable;
	}
}

/** Find all occurrences of an identifier in a document, returning their ranges */
function findAllOccurrences(content: string, name: string, doc: TextDocument): Range[] {
	const ranges: Range[] = [];
	const regex = new RegExp(`\\b${escapeRegex(name)}\\b`, 'g');
	let m;
	while ((m = regex.exec(content)) !== null) {
		const start = doc.positionAt(m.index);
		const end = doc.positionAt(m.index + name.length);
		ranges.push(Range.create(start, end));
	}
	return ranges;
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveImportUri(currentUri: string, importPath: string): string | null {
	if (!currentUri.startsWith('file://')) return null;
	const currentPath = currentUri.replace('file://', '');
	const dir = currentPath.substring(0, currentPath.lastIndexOf('/'));
	let targetPath = importPath;
	if (!targetPath.endsWith('.du')) targetPath += '.du';
	if (!targetPath.startsWith('/')) targetPath = dir + '/' + targetPath;
	return 'file://' + targetPath;
}

// ============================================================
// Go to Definition
// ============================================================

connection.onDefinition((params: DefinitionParams): Definition | null => {
	const textDoc = documents.get(params.textDocument.uri);
	if (!textDoc) return null;
	const lines = textDoc.getText().split("\n");
	const line = lines[params.position.line];
	if (!line) return null;
	const { word, wordStart } = getWordAtPosition(line, params.position.character);
	if (!word || keywords.includes(word)) return null;

	// import "path.du"
	const importPathMatch = line.match(/\bimport\s+["']([^"']+)["']/);
	if (importPathMatch) {
		const resolved = resolveImportUri(params.textDocument.uri, importPathMatch[1]);
		if (resolved) return Location.create(resolved, Range.create(0, 0, 0, 0));
	}

	// from "path.du" import X
	const fromPathMatch = line.match(/\bfrom\s+["']([^"']+)["']\s+import\b/);
	if (fromPathMatch) {
		const importListStart = line.indexOf('import', line.indexOf(fromPathMatch[0])) + 'import'.length;
		if (params.position.character >= importListStart) {
			const resolved = resolveImportUri(params.textDocument.uri, fromPathMatch[1]);
			if (resolved) {
				const targetSymbols = documentSymbols.get(resolved) || [];
				for (const sym of targetSymbols) {
					if (sym.name === word) return Location.create(sym.uri, Range.create(sym.line, sym.startChar, sym.line, sym.endChar));
				}
				return Location.create(resolved, Range.create(0, 0, 0, 0));
			}
		}
	}

	const defs = getAllDefinitions(word);
	if (defs.length > 0) {
		const nonSelf = defs.filter(d => !(d.uri === params.textDocument.uri && d.line === params.position.line && d.startChar === wordStart));
		const targets = nonSelf.length > 0 ? nonSelf : defs;
		if (targets.length === 1) return Location.create(targets[0].uri, Range.create(targets[0].line, targets[0].startChar, targets[0].line, targets[0].endChar));
		return targets.map(d => Location.create(d.uri, Range.create(d.line, d.startChar, d.line, d.endChar)));
	}
	return null;
});

// ============================================================
// Find All References
// ============================================================

connection.onReferences((params: ReferenceParams): Location[] | null => {
	const textDoc = documents.get(params.textDocument.uri);
	if (!textDoc) return null;
	const line = textDoc.getText().split("\n")[params.position.line];
	if (!line) return null;
	const { word } = getWordAtPosition(line, params.position.character);
	if (!word || keywords.includes(word)) return null;

	const results: Location[] = [];
	for (const doc of documents.all()) {
		const content = doc.getText();
		const ranges = findAllOccurrences(content, word, doc);
		for (const range of ranges) {
			results.push(Location.create(doc.uri, range));
		}
	}
	return results.length > 0 ? results : null;
});

// ============================================================
// Document Highlight (highlight same symbol in current file)
// ============================================================

connection.onDocumentHighlight((params: DocumentHighlightParams): DocumentHighlight[] | null => {
	const textDoc = documents.get(params.textDocument.uri);
	if (!textDoc) return null;
	const line = textDoc.getText().split("\n")[params.position.line];
	if (!line) return null;
	const { word } = getWordAtPosition(line, params.position.character);
	if (!word) return null;

	const content = textDoc.getText();
	const ranges = findAllOccurrences(content, word, textDoc);

	// Mark definitions as Write, usages as Read
	const defs = documentSymbols.get(textDoc.uri) || [];
	const defPositions = new Set(defs.filter(d => d.name === word).map(d => `${d.line}:${d.startChar}`));

	return ranges.map(range => ({
		range,
		kind: defPositions.has(`${range.start.line}:${range.start.character}`) ? DocumentHighlightKind.Write : DocumentHighlightKind.Read
	}));
});

// ============================================================
// Document Symbols (Outline / breadcrumbs)
// ============================================================

connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] | null => {
	const textDoc = documents.get(params.textDocument.uri);
	if (!textDoc) return null;
	const content = textDoc.getText();
	const lines = content.split('\n');
	const defs = documentSymbols.get(textDoc.uri) || [];

	const result: DocumentSymbol[] = [];

	// First pass: find classes and their ranges (for nesting methods inside classes)
	interface ClassBlock { name: string; startLine: number; endLine: number; symbol: DocumentSymbol; }
	const classBlocks: ClassBlock[] = [];

	for (const def of defs) {
		if (def.kind === 'class' || def.kind === 'trait' || def.kind === 'enum') {
			// Find the end of the class block by counting braces
			let braceDepth = 0;
			let started = false;
			let endLine = def.line;
			for (let i = def.line; i < lines.length; i++) {
				for (const ch of lines[i]) {
					if (ch === '{') { braceDepth++; started = true; }
					if (ch === '}') braceDepth--;
				}
				if (started && braceDepth === 0) { endLine = i; break; }
			}

			const sym: DocumentSymbol = {
				name: def.name,
				kind: kindForSymbol(def.kind),
				range: Range.create(def.line, 0, endLine, lines[endLine]?.length || 0),
				selectionRange: Range.create(def.line, def.startChar, def.line, def.endChar),
				children: []
			};
			classBlocks.push({ name: def.name, startLine: def.line, endLine, symbol: sym });
		}
	}

	// Second pass: add all symbols, nesting methods inside their class
	for (const def of defs) {
		if (def.kind === 'class' || def.kind === 'trait' || def.kind === 'enum') continue;

		const sym: DocumentSymbol = {
			name: def.name,
			kind: kindForSymbol(def.kind),
			range: Range.create(def.line, def.startChar, def.line, def.endChar),
			selectionRange: Range.create(def.line, def.startChar, def.line, def.endChar),
		};

		// Check if this def is inside a class block
		let addedToClass = false;
		if (def.kind === 'def') {
			for (const cls of classBlocks) {
				if (def.line > cls.startLine && def.line <= cls.endLine) {
					sym.kind = SymbolKind.Method;
					cls.symbol.children!.push(sym);
					addedToClass = true;
					break;
				}
			}
		}
		if (!addedToClass) result.push(sym);
	}

	// Add class symbols (with their nested children)
	result.push(...classBlocks.map(cb => cb.symbol));

	// Sort by line number
	result.sort((a, b) => a.range.start.line - b.range.start.line);

	return result;
});

// ============================================================
// Workspace Symbol search (Ctrl+T)
// ============================================================

connection.onWorkspaceSymbol((params: WorkspaceSymbolParams): SymbolInformation[] => {
	const query = params.query.toLowerCase();
	const results: SymbolInformation[] = [];

	for (const [uri, symbols] of documentSymbols) {
		for (const sym of symbols) {
			if (sym.name.toLowerCase().includes(query)) {
				results.push({
					name: sym.name,
					kind: kindForSymbol(sym.kind),
					location: Location.create(uri, Range.create(sym.line, sym.startChar, sym.line, sym.endChar))
				});
			}
		}
	}
	return results;
});

// ============================================================
// Rename Symbol (F2)
// ============================================================

connection.onPrepareRename((params: PrepareRenameParams): Range | null => {
	const textDoc = documents.get(params.textDocument.uri);
	if (!textDoc) return null;
	const line = textDoc.getText().split("\n")[params.position.line];
	if (!line) return null;
	const { word, wordStart, wordEnd } = getWordAtPosition(line, params.position.character);
	if (!word || keywords.includes(word)) return null;
	// Only allow renaming user-defined symbols
	if (builtIns.find(b => b.name === word)) return null;
	if (builtInModules.find(m => m.name === word)) return null;
	return Range.create(params.position.line, wordStart, params.position.line, wordEnd);
});

connection.onRenameRequest((params: RenameParams): WorkspaceEdit | null => {
	const textDoc = documents.get(params.textDocument.uri);
	if (!textDoc) return null;
	const line = textDoc.getText().split("\n")[params.position.line];
	if (!line) return null;
	const { word } = getWordAtPosition(line, params.position.character);
	if (!word || keywords.includes(word)) return null;

	const changes: { [uri: string]: TextEdit[] } = {};

	for (const doc of documents.all()) {
		const content = doc.getText();
		const ranges = findAllOccurrences(content, word, doc);
		if (ranges.length > 0) {
			changes[doc.uri] = ranges.map(range => TextEdit.replace(range, params.newName));
		}
	}

	return { changes };
});

// ============================================================
// Code Folding
// ============================================================

connection.onFoldingRanges((params: FoldingRangeParams): FoldingRange[] | null => {
	const textDoc = documents.get(params.textDocument.uri);
	if (!textDoc) return null;
	const content = textDoc.getText();
	const lines = content.split('\n');
	const ranges: FoldingRange[] = [];

	// Brace-based folding
	const braceStack: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		for (let j = 0; j < line.length; j++) {
			if (line[j] === '{') {
				braceStack.push(i);
			} else if (line[j] === '}') {
				if (braceStack.length > 0) {
					const startLine = braceStack.pop()!;
					if (i > startLine) {
						ranges.push({ startLine, endLine: i, kind: FoldingRangeKind.Region });
					}
				}
			}
		}
	}

	// Block comment folding
	let blockStart = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].includes('/*') && blockStart < 0) blockStart = i;
		if (lines[i].includes('*/') && blockStart >= 0) {
			if (i > blockStart) ranges.push({ startLine: blockStart, endLine: i, kind: FoldingRangeKind.Comment });
			blockStart = -1;
		}
	}

	// Consecutive single-line comment folding
	let commentStart = -1;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (trimmed.startsWith('//')) {
			if (commentStart < 0) commentStart = i;
		} else {
			if (commentStart >= 0 && i - 1 > commentStart) {
				ranges.push({ startLine: commentStart, endLine: i - 1, kind: FoldingRangeKind.Comment });
			}
			commentStart = -1;
		}
	}
	if (commentStart >= 0 && lines.length - 1 > commentStart) {
		ranges.push({ startLine: commentStart, endLine: lines.length - 1, kind: FoldingRangeKind.Comment });
	}

	// Import block folding
	let importStart = -1;
	let importEnd = -1;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
			if (importStart < 0) importStart = i;
			importEnd = i;
		} else if (importStart >= 0 && trimmed.length > 0) {
			if (importEnd > importStart) {
				ranges.push({ startLine: importStart, endLine: importEnd, kind: FoldingRangeKind.Imports });
			}
			importStart = -1;
		}
	}
	if (importStart >= 0 && importEnd > importStart) {
		ranges.push({ startLine: importStart, endLine: importEnd, kind: FoldingRangeKind.Imports });
	}

	return ranges;
});

// ============================================================
// Document Formatting
// ============================================================

connection.onDocumentFormatting((params: DocumentFormattingParams): TextEdit[] | null => {
	const textDoc = documents.get(params.textDocument.uri);
	if (!textDoc) return null;
	const content = textDoc.getText();
	const lines = content.split('\n');
	const tabSize = params.options.tabSize || 4;
	const insertSpaces = params.options.insertSpaces !== false;
	const indent = insertSpaces ? ' '.repeat(tabSize) : '\t';
	const edits: TextEdit[] = [];

	let depth = 0;
	let inBlockComment = false;

	for (let i = 0; i < lines.length; i++) {
		const original = lines[i];
		const trimmed = original.trim();

		if (trimmed.length === 0) continue; // skip blank lines

		// Track block comments
		if (inBlockComment) {
			if (trimmed.includes('*/')) inBlockComment = false;
			continue; // Don't re-indent inside block comments
		}
		if (trimmed.startsWith('/*')) {
			if (!trimmed.includes('*/')) inBlockComment = true;
			// Format the start of block comment
			const expected = indent.repeat(depth) + trimmed;
			if (original !== expected) {
				edits.push(TextEdit.replace(Range.create(i, 0, i, original.length), expected));
			}
			continue;
		}

		// Decrease indent before closing braces
		if (trimmed.startsWith('}')) depth = Math.max(0, depth - 1);

		const expected = indent.repeat(depth) + trimmed;

		if (original !== expected) {
			edits.push(TextEdit.replace(Range.create(i, 0, i, original.length), expected));
		}

		// Increase indent after opening braces
		// Count net braces on this line (ignoring strings and comments)
		let netBraces = 0;
		let inStr: string | null = null;
		let inLineComment = false;
		for (let j = 0; j < trimmed.length; j++) {
			const ch = trimmed[j];
			if (inLineComment) break;
			if (inStr) {
				if (ch === '\\') { j++; continue; }
				if (ch === inStr) inStr = null;
				continue;
			}
			if (ch === '/' && j + 1 < trimmed.length && trimmed[j + 1] === '/') { inLineComment = true; continue; }
			if (ch === '"' || ch === "'") { inStr = ch; continue; }
			if (ch === '{') netBraces++;
			if (ch === '}') netBraces--;
		}
		depth = Math.max(0, depth + netBraces);
	}

	// Ensure file ends with a single newline
	if (content.length > 0 && !content.endsWith('\n')) {
		edits.push(TextEdit.insert(Position.create(lines.length - 1, lines[lines.length - 1].length), '\n'));
	}

	// Remove trailing whitespace
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmedRight = line.replace(/\s+$/, '');
		if (line !== trimmedRight) {
			edits.push(TextEdit.replace(Range.create(i, trimmedRight.length, i, line.length), ''));
		}
	}

	return edits;
});

// ============================================================
// Code Actions (Quick fixes)
// ============================================================

connection.onCodeAction((params: CodeActionParams): CodeAction[] | null => {
	const textDoc = documents.get(params.textDocument.uri);
	if (!textDoc) return null;
	const actions: CodeAction[] = [];
	const diagnostics = params.context.diagnostics;

	for (const diag of diagnostics) {
		// Fix '= =' -> '=='
		if (diag.message.includes("Did you mean '=='")) {
			const line = textDoc.getText().split('\n')[diag.range.start.line];
			if (line) {
				const badText = line.substring(diag.range.start.character, diag.range.end.character);
				const fixed = badText.replace(/=\s+=/, '==');
				actions.push({
					title: "Replace with '=='",
					kind: CodeActionKind.QuickFix,
					diagnostics: [diag],
					edit: {
						changes: {
							[params.textDocument.uri]: [TextEdit.replace(diag.range, fixed)]
						}
					}
				});
			}
		}
	}

	// Offer "Add missing semicolon" for lines that look like they should end with one
	const lines = textDoc.getText().split('\n');
	for (let lineNum = params.range.start.line; lineNum <= params.range.end.line; lineNum++) {
		const line = lines[lineNum];
		if (!line) continue;
		const trimmed = line.trim();

		// Statements that should end with ; but don't
		if (trimmed.length > 0 && !trimmed.endsWith(';') && !trimmed.endsWith('{') && !trimmed.endsWith('}') && !trimmed.endsWith(',') && !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*')) {
			// Heuristic: only for var/const/import/return/print-like statements
			if (/^\s*(var|const|import|from|return|print|printError)\b/.test(line) && !trimmed.endsWith(';')) {
				actions.push({
					title: `Add missing ';' at end of line ${lineNum + 1}`,
					kind: CodeActionKind.QuickFix,
					edit: {
						changes: {
							[params.textDocument.uri]: [TextEdit.insert(Position.create(lineNum, line.length), ';')]
						}
					}
				});
			}
		}
	}

	return actions.length > 0 ? actions : null;
});

// ============================================================
// Document Links (clickable import paths)
// ============================================================

connection.onDocumentLinks((params: DocumentLinkParams): DocumentLink[] | null => {
	const textDoc = documents.get(params.textDocument.uri);
	if (!textDoc) return null;
	const content = textDoc.getText();
	const lines = content.split('\n');
	const links: DocumentLink[] = [];

	for (let lineNum = 0; lineNum < lines.length; lineNum++) {
		const line = lines[lineNum];

		// import "path.du"
		const importMatch = line.match(/\b(import|from)\s+["']([^"']+)["']/);
		if (importMatch && importMatch.index !== undefined) {
			const pathStart = line.indexOf(importMatch[2], importMatch.index);
			if (pathStart >= 0) {
				const resolved = resolveImportUri(textDoc.uri, importMatch[2]);
				if (resolved) {
					links.push({
						range: Range.create(lineNum, pathStart, lineNum, pathStart + importMatch[2].length),
						target: resolved
					});
				}
			}
		}
	}

	return links.length > 0 ? links : null;
});

// ============================================================
// Completion handler
// ============================================================

connection.onCompletion((document: CompletionParams): CompletionItem[] => {
	const textDoc = documents.get(document.textDocument.uri);
	if (!textDoc) return [];
	const content = textDoc.getText();
	const lines = content.split("\n");
	const line = lines[document.position.line];
	const position = document.position.character - 1;
	if (line === undefined) return [];

	switch (document.context?.triggerCharacter) {
		case ".": {
			// First check if this is a known module (Module.)
			const previousToken: string = getPreviousToken(line, position);
			const builtInMethods = findModuleMethods(previousToken);
			const builtInConstants = findModuleConstants(previousToken);

			if (builtInMethods.length > 0 || builtInConstants.length > 0) {
				let items: CompletionItem[] = [];
				items.push(...builtInMethods.map((method) => ({ label: method.name, kind: CompletionItemKind.Method, data: method.name, detail: method.detail, documentation: dictuDocumentationMarkdown(method.documentation) })));
				items.push(...builtInConstants.map((constant) => ({ label: constant.name, kind: CompletionItemKind.Constant, detail: constant.detail })));
				return items;
			}

			// Use the type inference engine to determine what's before the dot
			const inferredType = inferTypeBeforeDot(line, position, document.textDocument.uri);
			if (inferredType && inferredType !== 'module') {
				return buildTypeMethodCompletions(inferredType);
			}

			// Fallback: offer all methods from all types
			let allMethods: CompletionItem[] = [];
			for (const typeName of Object.keys(typeMethods)) {
				for (const method of typeMethods[typeName]) {
					if (!allMethods.find(m => m.label === method.name)) {
						allMethods.push({ label: method.name, kind: CompletionItemKind.Method, detail: method.detail, documentation: dictuDocumentationMarkdown(method.documentation) });
					}
				}
			}
			return allMethods;
		}

		default: {
			if (line.slice(Math.max(0, position - 7), position + 1).includes("import")) {
				return builtInModules.map(module => ({ label: module.name, kind: CompletionItemKind.Module, detail: module.detail, documentation: dictuDocumentationMarkdown(module.documentation) }));
			}

			let defaultCompletion: CompletionItem[] = [];
			for (let keyword of keywords) defaultCompletion.push({ label: keyword, kind: CompletionItemKind.Keyword });
			for (let builtIn of builtIns) defaultCompletion.push({ label: builtIn.name, kind: CompletionItemKind.Function, detail: builtIn.detail, documentation: dictuDocumentationMarkdown(builtIn.documentation) });
			for (let module of builtInModules) defaultCompletion.push({ label: module.name, kind: CompletionItemKind.Module, detail: module.detail, documentation: dictuDocumentationMarkdown(module.documentation) });

			for (let snippet in snippets) {
				const start = Position.create(document.position.line, document.position.character - 1);
				const range = Range.create(start, document.position);
				defaultCompletion.push({
					label: snippet, kind: CompletionItemKind.Snippet, insertTextFormat: InsertTextFormat.Snippet,
					textEdit: TextEdit.replace(range, snippets[snippet].content),
					detail: snippets[snippet].detail,
					documentation: { value: "```dictu\n" + snippets[snippet].content.replace(/\$\{?\d+(?::([^}]*))?\}?/g, "$1") + "\n```", kind: MarkupKind.Markdown }
				});
			}

			if (knownSymbols.length > 0) defaultCompletion.push(...knownSymbols);
			return defaultCompletion;
		}
	}
});

// ============================================================
// Hover handler
// ============================================================

connection.onHover((params: HoverParams): Hover | null => {
	const textDoc = documents.get(params.textDocument.uri);
	if (!textDoc) return null;
	const lines = textDoc.getText().split("\n");
	const line = lines[params.position.line];
	if (!line) return null;
	const { word, wordStart, wordEnd } = getWordAtPosition(line, params.position.character);
	if (!word) return null;

	let fullToken = word;
	let receiverType: DictuType = null;
	if (wordStart > 0 && line[wordStart - 1] === '.') {
		let moduleStart = wordStart - 1;
		while (moduleStart > 0 && /[a-zA-Z0-9_]/.test(line[moduleStart - 1])) moduleStart--;
		const moduleName = line.substring(moduleStart, wordStart - 1);
		if (moduleName) fullToken = `${moduleName}.${word}`;
		// Infer the receiver type to give context-specific hover
		receiverType = inferTypeBeforeDot(line, wordStart - 1, params.textDocument.uri);
	}

	const info = hoverMap.get(fullToken) || hoverMap.get(word);
	if (info) {
		return {
			contents: { kind: MarkupKind.Markdown, value: `**${info.detail}**\n\n\`\`\`dictu\n${info.documentation}\n\`\`\`` },
			range: Range.create(params.position.line, wordStart, params.position.line, wordEnd)
		};
	}

	// If we know the receiver type, show only that type's method info
	if (receiverType && typeMethods[receiverType]) {
		for (const method of typeMethods[receiverType]) {
			if (method.name === word) {
				return {
					contents: { kind: MarkupKind.Markdown, value: `**(${receiverType} method) ${method.name}**\n\n${method.detail}\n\n\`\`\`dictu\n${method.documentation}\n\`\`\`` },
					range: Range.create(params.position.line, wordStart, params.position.line, wordEnd)
				};
			}
		}
	}

	// Fallback: search all type methods
	for (const typeName of Object.keys(typeMethods)) {
		for (const method of typeMethods[typeName]) {
			if (method.name === word) {
				return {
					contents: { kind: MarkupKind.Markdown, value: `**(${typeName} method) ${method.name}**\n\n${method.detail}\n\n\`\`\`dictu\n${method.documentation}\n\`\`\`` },
					range: Range.create(params.position.line, wordStart, params.position.line, wordEnd)
				};
			}
		}
	}

	const defs = getAllDefinitions(word);
	if (defs.length > 0) {
		const d = defs[0];
		const kindLabel = d.kind === 'def' ? 'function' : d.kind;
		// Show inferred type if available
		const varTypes = documentVariableTypes.get(params.textDocument.uri);
		const inferredType = varTypes?.get(word);
		const typeInfo = inferredType ? `: ${inferredType}` : '';
		return {
			contents: { kind: MarkupKind.Markdown, value: `**(${kindLabel})** \`${word}\`${typeInfo}` },
			range: Range.create(params.position.line, wordStart, params.position.line, wordEnd)
		};
	}
	return null;
});

// ============================================================
// Signature help handler
// ============================================================

connection.onSignatureHelp((params: SignatureHelpParams): SignatureHelp | null => {
	const textDoc = documents.get(params.textDocument.uri);
	if (!textDoc) return null;
	const lines = textDoc.getText().split("\n");
	const line = lines[params.position.line];
	if (!line) return null;
	const pos = params.position.character;

	let parenDepth = 0, funcEnd = -1, activeParam = 0;
	for (let i = pos - 1; i >= 0; i--) {
		const ch = line[i];
		if (ch === ')') parenDepth++;
		else if (ch === '(') { if (parenDepth === 0) { funcEnd = i; break; } parenDepth--; }
		else if (ch === ',' && parenDepth === 0) activeParam++;
	}
	if (funcEnd < 0) return null;

	let funcStart = funcEnd;
	while (funcStart > 0 && /[a-zA-Z0-9_.]/.test(line[funcStart - 1])) funcStart--;
	const funcName = line.substring(funcStart, funcEnd);
	if (!funcName) return null;

	for (const builtin of builtIns) {
		if (builtin.name === funcName) {
			return { signatures: [{ label: `${builtin.name}(...)`, documentation: { kind: MarkupKind.Markdown, value: builtin.detail } as MarkupContent }], activeSignature: 0, activeParameter: activeParam };
		}
	}

	const parts = funcName.split('.');
	if (parts.length === 2) {
		for (const method of findModuleMethods(parts[0])) {
			if (method.name === parts[1]) {
				return { signatures: [{ label: `${funcName}(...)`, documentation: { kind: MarkupKind.Markdown, value: `${method.detail}\n\n\`\`\`dictu\n${method.documentation}\n\`\`\`` } as MarkupContent }], activeSignature: 0, activeParameter: activeParam };
			}
		}
	}
	return null;
});

// ============================================================
// Listen
// ============================================================

documents.listen(connection);
connection.listen();
