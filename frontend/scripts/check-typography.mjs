import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = path.join(frontendRoot, 'src');
const properties = new Set(['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing']);
const tokenPrefixes = {
  fontFamily: '--font-',
  fontSize: '--text-',
  fontWeight: '--font-',
  lineHeight: '--leading-',
  letterSpacing: '--tracking-',
};
const cssProperties = {
  'font-family': 'fontFamily',
  'font-size': 'fontSize',
  'font-weight': 'fontWeight',
  'line-height': 'lineHeight',
  'letter-spacing': 'letterSpacing',
};
const cssWideKeywords = new Set(['inherit', 'unset', 'revert', 'revert-layer']);
const violations = [];

function walkFiles(directory, extension, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(fullPath, extension, output);
    else if (entry.name.endsWith(extension)) output.push(fullPath);
  }
  return output;
}

function report(file, line, column, property, value) {
  violations.push(`${path.relative(frontendRoot, file)}:${line}:${column} ${property} uses ${value}; use its typography token instead`);
}

function isTokenReference(value, property) {
  return new RegExp(`^var\\(${tokenPrefixes[property]}[a-z0-9-]+\\)$`).test(value);
}

function checkTsx(file) {
  const source = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const styleObjects = new Set();
  const styleVariables = new Set();
  const styleFunctions = new Set();

  function markExpression(expression) {
    if (!expression) return;
    if (ts.isObjectLiteralExpression(expression)) styleObjects.add(expression);
    else if (ts.isIdentifier(expression)) styleVariables.add(expression.text);
    else if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) styleFunctions.add(expression.expression.text);
    else if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
      markExpression(expression.expression);
    } else if (ts.isConditionalExpression(expression)) {
      markExpression(expression.whenTrue);
      markExpression(expression.whenFalse);
    }
  }

  function markReturnedStyles(node) {
    if (ts.isBlock(node.body)) {
      function collectReturns(returnNode) {
        if (ts.isReturnStatement(returnNode)) markExpression(returnNode.expression);
        ts.forEachChild(returnNode, collectReturns);
      }
      collectReturns(node.body);
    } else {
      markExpression(node.body);
    }
  }

  function collect(node) {
    if (ts.isJsxAttribute(node) && node.name.text === 'style' && node.initializer && ts.isJsxExpression(node.initializer)) {
      markExpression(node.initializer.expression);
    }
    if (ts.isVariableDeclaration(node) && node.type?.getText(sourceFile).includes('CSSProperties') && ts.isIdentifier(node.name)) {
      styleVariables.add(node.name.text);
    }
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node))
      && node.type?.getText(sourceFile).includes('CSSProperties')) {
      markReturnedStyles(node);
    }
    if (ts.isCallExpression(node) && node.expression.getText(sourceFile).endsWith('EditorView.theme')) {
      markExpression(node.arguments[0]);
    }
    ts.forEachChild(node, collect);
  }
  collect(sourceFile);

  let grew = true;
  while (grew) {
    grew = false;
    function resolve(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        if (styleVariables.has(node.name.text)) {
          const before = styleObjects.size;
          markExpression(node.initializer);
          if (styleObjects.size > before) grew = true;
        }
        if (styleFunctions.has(node.name.text) && node.initializer
          && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
          const before = styleObjects.size + styleVariables.size;
          markReturnedStyles(node.initializer);
          if (styleObjects.size + styleVariables.size > before) grew = true;
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name && styleFunctions.has(node.name.text)) {
        const before = styleObjects.size + styleVariables.size;
        markReturnedStyles(node);
        if (styleObjects.size + styleVariables.size > before) grew = true;
      }
      if (ts.isSpreadAssignment(node) && styleObjects.has(node.parent) && ts.isIdentifier(node.expression)
        && !styleVariables.has(node.expression.text)) {
        styleVariables.add(node.expression.text);
        grew = true;
      }
      ts.forEachChild(node, resolve);
    }
    resolve(sourceFile);
  }

  function inspectValue(node, property) {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      inspectValue(node.expression, property);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      inspectValue(node.whenTrue, property);
      inspectValue(node.whenFalse, property);
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isTokenReference(node.text, property) && !cssWideKeywords.has(node.text)) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        report(file, position.line + 1, position.character + 1, property, JSON.stringify(node.text));
      }
      return;
    }
    if (ts.isNumericLiteral(node) || (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand))) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      report(file, position.line + 1, position.character + 1, property, node.getText(sourceFile));
    }
  }

  for (const object of styleObjects) {
    for (const member of object.properties) {
      if (!ts.isPropertyAssignment(member)) continue;
      const property = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : '';
      if (properties.has(property)) inspectValue(member.initializer, property);
    }
  }
}

function checkCss(file) {
  const source = fs.readFileSync(file, 'utf8');
  const declaration = /(?:^|[;{])\s*(font-family|font-size|font-weight|line-height|letter-spacing)\s*:\s*([^;}]+)/g;
  for (const match of source.matchAll(declaration)) {
    const cssProperty = match[1];
    const property = cssProperties[cssProperty];
    const value = match[2].trim();
    const fluidSize = property === 'fontSize'
      && /^clamp\(\s*var\(--text-[a-z0-9-]+\)\s*,\s*[^,]+,\s*var\(--text-[a-z0-9-]+\)\s*\)$/.test(value);
    if (isTokenReference(value, property) || fluidSize || cssWideKeywords.has(value)) continue;
    const offset = match.index + match[0].indexOf(match[2]);
    const before = source.slice(0, offset);
    const lines = before.split('\n');
    report(file, lines.length, lines.at(-1).length + 1, cssProperty, JSON.stringify(value));
  }
}

for (const file of walkFiles(sourceRoot, '.tsx')) checkTsx(file);
for (const file of walkFiles(sourceRoot, '.css')) checkCss(file);

if (violations.length) {
  console.error(`Typography check failed with ${violations.length} hardcoded value${violations.length === 1 ? '' : 's'}:`);
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Typography check passed: component and CSS typography values use the shared tokens.');
}
