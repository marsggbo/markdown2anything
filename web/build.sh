#!/usr/bin/env bash
# 构建 web 版静态资源：m2a-render.js / codemirror.bundle.js / html2canvas.min.js
set -e
cd "$(dirname "$0")/.."

echo "── 1/3 打包渲染核心 (m2a-render.js) ──"
./node_modules/.bin/esbuild web/src/render.js \
  --bundle --format=iife --global-name=M2A --platform=browser \
  --outfile=web/m2a-render.js

echo "── 2/3 打包 CodeMirror (vendor/codemirror.bundle.js) ──"
cat > web/src/cm-entry.js << 'CMEOF'
import { basicSetup, EditorView } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
window.CodeMirror = { EditorView, basicSetup, markdown, EditorState };
window.CodeMirror.state = { EditorState };
CMEOF
./node_modules/.bin/esbuild web/src/cm-entry.js \
  --bundle --format=iife --global-name=CodeMirrorGlobal --platform=browser \
  --outfile=web/vendor/codemirror.bundle.js

echo "── 3/3 复制 html2canvas ──"
cp node_modules/html2canvas/dist/html2canvas.min.js web/vendor/html2canvas.min.js

echo "✅ 构建完成"
ls -la web/m2a-render.js web/vendor/codemirror.bundle.js web/vendor/html2canvas.min.js
