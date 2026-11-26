import { JSDOM } from 'jsdom';
import mermaid from 'mermaid';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.DOMParser = dom.window.DOMParser;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.Element = dom.window.Element;

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
const source = process.argv[2] || '';
const id = process.argv[3] || 'm2a-mermaid';
try {
  const result = await mermaid.render(id, source);
  process.stdout.write(result.svg);
} catch (_) {
  process.exitCode = 1;
}
