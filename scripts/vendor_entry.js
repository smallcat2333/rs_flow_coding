// 离线前端依赖打包入口：由 scripts/build_vendor.py 用 esbuild 打成 ui/vendor/vendor.js（IIFE，全局 window.Vendor）。
// 只暴露前端实际使用的接口：CodeMirror 6 Markdown 编辑器与 marked 渲染。
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Transaction, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab, undo, redo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { marked } from 'marked';

window.Vendor = { EditorView, EditorState, Transaction, Compartment, basicSetup, keymap, indentWithTab, undo, redo, markdown, oneDark, marked };
