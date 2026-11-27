// Generates the Design System's component types file (`components/index.d.ts`)
// and each component's source path (`tokens.json` `meta.components`) from the
// bundle entry, with the TypeScript checker. The components are the keys of
// `components` in entry.tsx and the data is its `data`; each one's props and
// return type are the real ones, and every type of the repo they reach is
// written out, so a renamed status or prop can't stay stale.
//
// A component's source is the file entry.tsx imports it from. One declared in
// entry.tsx itself (a wrapper that fills in demo data) takes the source of the
// imported component it renders at its root, and one that composes several
// is its own source, entry.tsx.
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { entry } from "./components.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const ts = createRequire(join(repo, "package.json"))("typescript");

const header = `// window.Acb: the site's real components (acarbonellb/acb-landing-public,
// src/components), compiled for React 19. Generated from the repository's
// TypeScript by the design-system-sync skill; edits here are overwritten.
`;

/**
 * `{ dts, sources, inputs }`: the types file's text, `{ <component>: <repo path> }`
 * and the repo files the checker read (type-only imports included, which the
 * bundle never reads), outside this skill.
 */
export function componentTypes() {
  const config = ts.getParsedCommandLineOfConfigFile(join(repo, "tsconfig.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  });
  const program = ts.createProgram([entry], { ...config.options, incremental: false, noEmit: true });
  const errors = ts.getPreEmitDiagnostics(program, program.getSourceFile(entry));
  if (errors.length) {
    throw new Error(
      `entry.tsx doesn't type-check:\n  ${errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n  ")}`,
    );
  }
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const repoPath = (file) => relative(repo, file);
  const inRepo = (file) => !repoPath(file).startsWith("..") && !file.includes("/node_modules/");

  const initializer = (name) => {
    let found;
    source.forEachChild(function walk(n) {
      if (ts.isVariableDeclaration(n) && n.name.getText(source) === name) found = n.initializer;
      else n.forEachChild(walk);
    });
    if (!found || !ts.isObjectLiteralExpression(found)) throw new Error(`entry.tsx has no \`const ${name} = { ... }\``);
    return found;
  };

  // Where a component comes from: the file its import names, or for one
  // declared here, that of the imported component it renders at its root.
  const sourceOf = (name, symbol) => {
    if (symbol.flags & ts.SymbolFlags.Alias) {
      const decl = checker.getAliasedSymbol(symbol).declarations?.[0];
      if (!decl || !inRepo(decl.getSourceFile().fileName)) throw new Error(`${name} isn't imported from the repo`);
      return repoPath(decl.getSourceFile().fileName);
    }
    const decl = symbol.declarations?.[0];
    let fn = decl && ts.isVariableDeclaration(decl) ? decl.initializer : decl;
    while (fn && ts.isParenthesizedExpression(fn)) fn = fn.expression;
    let body = fn && (ts.isArrowFunction(fn) || ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) ? fn.body : undefined;
    if (body && ts.isBlock(body)) body = body.statements.find(ts.isReturnStatement)?.expression;
    while (body && ts.isParenthesizedExpression(body)) body = body.expression;
    const tag = body && (ts.isJsxElement(body) ? body.openingElement.tagName : ts.isJsxSelfClosingElement(body) ? body.tagName : undefined);
    const tagSymbol = tag && ts.isIdentifier(tag) ? checker.getSymbolAtLocation(tag) : undefined;
    // One composed here from several components is its own source.
    if (!tagSymbol || !(tagSymbol.flags & ts.SymbolFlags.Alias)) return repoPath(entry);
    return sourceOf(name, tagSymbol);
  };

  // The printer. A type with a name is written by name: the repo's own
  // (written out once, in the order they're met), React's (imported) and
  // TypeScript's globals. Any other is written out in full. Properties keep
  // the type they're declared with, so an alias like `AgentStatus` survives.
  const named = new Map();
  const react = new Set();
  const nameOf = (symbol) => {
    const file = symbol.declarations?.[0]?.getSourceFile().fileName ?? "";
    if (file.includes("/node_modules/@types/react/")) {
      const chain = [symbol.name];
      for (let s = symbol.parent; s && s.name !== "React" && !s.name.startsWith('"'); s = s.parent) chain.unshift(s.name);
      react.add(chain[0]);
      return chain.join(".");
    }
    if (file.includes("/node_modules/typescript/lib/")) return symbol.name;
    if (!inRepo(file)) {
      throw new Error(`${symbol.name} comes from ${file}: the types file can only name the repo's, React's and global types`);
    }
    const decl = symbol.declarations[0];
    const where = `${symbol.name} (${repoPath(file)})`;
    if (!ts.isTypeAliasDeclaration(decl)) throw new Error(`${where} is an interface or class: declare it with \`type\``);
    if (decl.typeParameters?.length) throw new Error(`${where} is generic: the types file can't write it`);
    const known = named.get(symbol.name);
    if (known && known.symbol !== symbol) throw new Error(`two repo types are called ${symbol.name}`);
    if (!known) {
      const entry = { symbol, text: "" };
      named.set(symbol.name, entry);
      entry.text = printNode(decl.type, "", true);
    }
    return symbol.name;
  };
  const withArgs = (name, args) => (args?.length ? `${name}<${args.map((a) => print(a)).join(", ")}>` : name);
  const wrap = (type, text) => ((type.isUnion() || type.isIntersection()) && !type.aliasSymbol ? `(${text})` : text);
  // A symbol's type as its declaration writes it. TypeScript drops an alias
  // whose type already exists under another name (`AgentStatus` is
  // `(typeof agentStatuses)[number]`), so a reference to one of the repo's
  // aliases is kept from the declaration itself.
  const printDeclared = (symbol, indent = "", expand = false) => {
    const node = symbol.valueDeclaration?.type;
    return node ? printNode(node, indent, expand) : print(checker.getTypeOfSymbol(symbol), indent, expand);
  };
  const printNode = (node, indent, expand = false) => {
    if (ts.isParenthesizedTypeNode(node)) return printNode(node.type, indent, expand);
    if (ts.isUnionTypeNode(node)) return node.types.map((t) => printNode(t, indent)).join(" | ");
    if (ts.isArrayTypeNode(node)) {
      const element = printNode(node.elementType, indent);
      return ts.isUnionTypeNode(node.elementType) ? `(${element})[]` : `${element}[]`;
    }
    if (!expand && ts.isTypeReferenceNode(node) && !node.typeArguments) {
      let symbol = checker.getSymbolAtLocation(node.typeName);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const decl = symbol?.declarations?.[0];
      if (decl && ts.isTypeAliasDeclaration(decl) && inRepo(decl.getSourceFile().fileName)) return nameOf(symbol);
    }
    return print(checker.getTypeFromTypeNode(node), indent, expand);
  };
  const docText = (symbol) =>
    ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim().replace(/\s*\n\s*/g, " ");
  const doc = (symbol) => (docText(symbol) ? `/** ${docText(symbol)} */\n` : "");

  const print = (type, indent = "", expand = false) => {
    if (!expand && type.aliasSymbol) return withArgs(nameOf(type.aliasSymbol), type.aliasTypeArguments);
    if (type.flags & ts.TypeFlags.Boolean) return "boolean";
    if (type.isUnion()) {
      const bools = type.types.filter((t) => t.flags & ts.TypeFlags.BooleanLiteral);
      const both = bools.length === 2;
      const out = [];
      for (const t of type.types) {
        if (both && t === bools[0]) out.push("boolean");
        else if (!(both && t === bools[1])) out.push(print(t, indent));
      }
      return out.join(" | ");
    }
    if (type.isIntersection()) return type.types.map((t) => wrap(t, print(t, indent))).join(" & ");
    if (!(type.flags & ts.TypeFlags.Object)) return checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
    if (checker.isArrayType(type)) {
      const [element] = checker.getTypeArguments(type);
      const readonly = type.target.symbol.name === "ReadonlyArray" ? "readonly " : "";
      return `${readonly}${wrap(element, print(element, indent))}[]`;
    }
    if (checker.isTupleType(type)) throw new Error(`the types file can't write a tuple yet (${checker.typeToString(type)})`);
    const reference = type.objectFlags & ts.ObjectFlags.Reference;
    const symbol = reference ? type.target.symbol : type.symbol;
    if (symbol && symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class)) {
      return withArgs(nameOf(symbol), reference ? checker.getTypeArguments(type) : undefined);
    }
    const inner = indent + "  ";
    const properties = checker.getPropertiesOfType(type);
    const lines = [];
    for (const info of checker.getIndexInfosOfType(type)) {
      lines.push({ text: `[key: ${print(info.keyType)}]: ${print(info.type, inner)}` });
    }
    for (const sig of checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
      const params = sig.parameters.map((p) => `${p.name}: ${printDeclared(p, inner)}`).join(", ");
      const text = `(${params}) => ${print(checker.getReturnTypeOfSignature(sig), inner)}`;
      if (!properties.length && !lines.length) return text;
      lines.push({ text });
    }
    for (const p of properties) {
      const d = p.valueDeclaration;
      const readonly = d && ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Readonly ? "readonly " : "";
      const key = /^[A-Za-z_$][\w$]*$/.test(p.name) ? p.name : JSON.stringify(p.name);
      const optional = p.flags & ts.SymbolFlags.Optional ? "?" : "";
      lines.push({ doc: docText(p), text: `${readonly}${key}${optional}: ${printDeclared(p, inner)}` });
    }
    if (!lines.length) return "{}";
    if (lines.some((l) => l.doc || l.text.includes("\n"))) {
      const body = lines.map((l) => (l.doc ? `${inner}/** ${l.doc} */\n` : "") + `${inner}${l.text};`);
      return `{\n${body.join("\n")}\n${indent}}`;
    }
    return `{ ${lines.map((l) => l.text).join("; ")} }`;
  };

  const sources = {};
  const declarations = [];
  for (const p of initializer("components").properties) {
    const name = p.name.getText(source);
    const symbol = ts.isShorthandPropertyAssignment(p)
      ? checker.getShorthandAssignmentValueSymbol(p)
      : ts.isIdentifier(p.initializer)
        ? checker.getSymbolAtLocation(p.initializer)
        : undefined;
    if (!symbol) throw new Error(`components.${name} in entry.tsx must name a component`);
    sources[name] = sourceOf(name, symbol);
    const signatures = checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(symbol, p), ts.SignatureKind.Call);
    if (signatures.length !== 1) throw new Error(`components.${name} in entry.tsx must be one function component`);
    const [signature] = signatures;
    const param = signature.parameters[0];
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    declarations.push(
      `export type ${name}Props = ${param ? printDeclared(param, "", true) : "{}"};\n` +
        doc(target) +
        `export declare const ${name}: (p: ${name}Props) => ${print(checker.getReturnTypeOfSignature(signature))};`,
    );
  }

  const data = initializer("data").properties.map((p) => {
    let symbol = ts.isShorthandPropertyAssignment(p) ? checker.getShorthandAssignmentValueSymbol(p) : undefined;
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const text = symbol ? printDeclared(symbol, "  ") : print(checker.getTypeAtLocation(p.initializer), "  ");
    return `  ${p.name.getText(source)}: ${text};`;
  });

  for (const n of named.keys()) {
    if (n.endsWith("Props") && n.slice(0, -5) in sources) {
      throw new Error(`${n} clashes with the generated props type of ${n.slice(0, -5)}`);
    }
  }
  const dts =
    header +
    (react.size ? `import type { ${[...react].sort().join(", ")} } from "react";\n` : "") +
    "\n" +
    [...named.values()].map(({ symbol, text }) => `${doc(symbol)}export type ${symbol.name} = ${text};`).join("\n") +
    "\n\n" +
    declarations.join("\n\n") +
    `\n\n/** The site's real content, as the home page passes it. */\nexport declare const data: {\n${data.join("\n")}\n};\n`;
  const inputs = program
    .getSourceFiles()
    .map((f) => f.fileName)
    .filter(inRepo)
    .map(repoPath)
    .filter((p) => !p.startsWith(".claude/"));
  return { dts, sources, inputs };
}
