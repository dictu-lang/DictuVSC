# Contributing

## Structure

```
.
├── client // Language Client
│   ├── src
│   │   ├── test // End to End tests for Language Client / Server
│   │   └── extension.ts // Language Client entry point
├── package.json // The extension manifest.
└── server // Language Server
    └── src
	    ├── language.json // Configuration file for language autocompletion
        └── server.ts // Language Server entry point
```

## Functionality

### Syntax highlighting

Syntax highlighting is handled via different rules within the [textmate language file](client/syntaxes/dictu.tmLanguage.json). To add / change / remove different highlighting rules you can extend current Regex rules which
are there or add new TextMate grammers ([see here for more info](https://code.visualstudio.com/api/language-extensions/syntax-highlight-guide)).

### Auto completion

Auto completion is handled via LSP written in TypeScript. A lot of the rules are contained within [language.json](server/src/language.json). To add new snippets / autocompletion targets, simply update the configuration file, otherwise see [server.ts](server/src/server.ts).

## Running the Sample

- Run `npm install` in this folder. This installs all necessary npm modules in both the client and server folder
- Open VS Code on this folder.
- Press Ctrl+Shift+B to compile the client and server.
- Switch to the Debug viewlet.
- Select `Launch Client` from the drop down.
- Run the launch config.
- If you want to debug the server as well use the launch configuration `Attach to Server`
- In the [Extension Development Host] instance of VSCode, open a document in 'dictu' language mode.
  - Type `print` and see autocompletion along with syntax highlighting.