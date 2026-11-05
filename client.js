/**
 * Client half of the workspace file manager.
 *
 * It shadows the shipped `files` tab body (same keyed seat, lower render
 * priority) and turns the panel into a complete file manager: multi-select
 * tree, context menu, inline text editor, media/text preview, upload with
 * drag-and-drop, download, zip/tar compression and extraction, all backed by
 * the four authenticated routes the host half registers.
 */
window.__ModuleLoader__.load({
	id: 'dsh-file-manager',
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		const { useState, useRef, useEffect, useMemo, useCallback } = React;

		/* The host's own Markdown renderer — the identical component the chat
		 * transcript and the shipped document preview use. It is a *host*
		 * dependency, so it is optional here: a host that does not export it
		 * (older build, or a stubbed loader in tests) must degrade to the
		 * syntax-highlighted source view rather than blank the panel.
		 *
		 * The export is wrapped in `React.memo`, so it is an object with a
		 * `$$typeof` tag rather than a plain function — testing for `function`
		 * would silently discard the very component we came for. Accept any
		 * renderable component type: a function, or a memo/forwardRef object. */
		let MarkdownText = null;
		try {
			const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
			const candidate = primitives ? primitives.MarkdownText : null;
			const renderable = typeof candidate === 'function'
				|| (typeof candidate === 'object' && candidate !== null && typeof candidate.$$typeof === 'symbol');
			if (renderable) MarkdownText = candidate;
		} catch (error) {
			MarkdownText = null;
		}

		/** Keyed seat this panel shadows; the shipped definition keeps the tab type. */
		const FILES_ID = '@deepseek-ai/dsh-client-ui-sidebar-files';
		const NS = 'fileManager';

		/* ------------------------------------------------------------- icons */

		const P = (d, props) => h('path', { d, ...props });
		const C = (cx, cy, r, props) => h('circle', { cx, cy, r, ...props });
		const R = (x, y, width, height, rx, props) => h('rect', { x, y, width, height, rx, ...props });

		const makeIcon = (children) => function Icon({ size = 16, className, style }) {
			return h('svg', {
				viewBox: '0 0 16 16',
				width: size,
				height: size,
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.3,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				className,
				style,
				'aria-hidden': true,
				focusable: false
			}, children.map((child, index) => React.cloneElement(child, { key: index })));
		};

		const I = {
			folder: makeIcon([P('M1.75 4.4c0-.55.45-1 1-1h3.15l1.3 1.5h6.05c.55 0 1 .45 1 1v6.2c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z')]),
			chevron: makeIcon([P('M6.2 4.2L10.4 8l-4.2 3.8')]),
			chevronDown: makeIcon([P('M4.2 6.2L8 10.4l3.8-4.2')]),
			plus: makeIcon([P('M8 3.2v9.6M3.2 8h9.6')]),
			upload: makeIcon([P('M8 10.8V3.2M4.6 6.4L8 3l3.4 3.4'), P('M2.6 12.6v1.2h10.8v-1.2')]),
			refresh: makeIcon([P('M13.1 6.6A5.2 5.2 0 1 0 13.2 9'), P('M13.3 2.9v3.9H9.4')]),
			more: makeIcon([
				C(3.4, 8, 1.05, { fill: 'currentColor', stroke: 'none' }),
				C(8, 8, 1.05, { fill: 'currentColor', stroke: 'none' }),
				C(12.6, 8, 1.05, { fill: 'currentColor', stroke: 'none' })
			]),
			close: makeIcon([P('M4 4l8 8M12 4l-8 8')]),
			save: makeIcon([R(2.6, 2.6, 10.8, 10.8, 1.4), P('M5.2 2.6v3.6h5.2V2.6'), R(5, 8.9, 6, 4.5, 0.6)]),
			download: makeIcon([P('M8 3.2v8M4.6 7.8L8 11.2l3.4-3.4'), P('M2.6 13.2h10.8')]),
			trash: makeIcon([P('M2.8 4.4h10.4M6 4.4V2.9h4v1.5M4.3 4.4l.7 9.1h6l.7-9.1')]),
			edit: makeIcon([P('M11.2 2.6l2.2 2.2-8 8-2.9.7.7-2.9z')]),
			copy: makeIcon([R(5.4, 5.4, 8.4, 8.4, 1.2), P('M10.6 5.4V3.1c0-.4-.3-.7-.7-.7H3.1c-.4 0-.7.3-.7.7v6.8c0 .4.3.7.7.7h2.3')]),
			cut: makeIcon([C(4.4, 11.6, 1.75), C(11.6, 11.6, 1.75), P('M5.65 10.4L12.2 2.6M10.35 10.4L3.8 2.6')]),
			paste: makeIcon([P('M5.6 3.1H4.2c-.5 0-.9.4-.9.9v8.6c0 .5.4.9.9.9h7.6c.5 0 .9-.4.9-.9V4c0-.5-.4-.9-.9-.9h-1.4'), R(5.5, 1.8, 5, 2.6, 0.8)]),
			archive: makeIcon([R(2.2, 4.9, 11.6, 8.9, 1.1), P('M2.2 7.9h11.6'), P('M8 7.9v3.2')]),
			extract: makeIcon([P('M9.3 2.5h4.2v4.2'), P('M13.5 2.5L7.8 8.2'), P('M6.2 4.1H3.1c-.5 0-.9.4-.9.9v7.9c0 .5.4.9.9.9h7.9c.5 0 .9-.4.9-.9V9.8')]),
			external: makeIcon([P('M9.4 2.5h4.1v4.1'), P('M13.5 2.5L7.6 8.4'), P('M12.2 9.7v3.2c0 .5-.4.9-.9.9H3.4c-.5 0-.9-.4-.9-.9V4.9c0-.5.4-.9.9-.9h3.2')]),
			image: makeIcon([R(2.2, 3.2, 11.6, 9.6, 1.2), C(5.6, 6.4, 1.1), P('M3.2 11.6l3.3-3.1 2.4 2.2 1.6-1.5 2.3 2.4')]),
			info: makeIcon([C(8, 8, 5.9), P('M8 7.2v4.1'), P('M8 4.9v.1')]),
			search: makeIcon([C(7.1, 7.1, 4.1), P('M10.2 10.2L13.6 13.6')]),
			chat: makeIcon([P('M2.4 4.6c0-.9.7-1.6 1.6-1.6h8c.9 0 1.6.7 1.6 1.6v4.6c0 .9-.7 1.6-1.6 1.6H7.6l-3.1 2.6v-2.6h-.5c-.9 0-1.6-.7-1.6-1.6z')]),
			file: makeIcon([P('M4.1 2.4h4.9l2.9 2.9v8.3H4.1z'), P('M8.9 2.4v2.9h2.9')]),
			/* "M↓" — the Markdown mark, used for the rendered/source toggle so it
			 * reads as a format switch rather than as the generic file glyph. */
			markdown: makeIcon([P('M2.2 4.4h11.6v7.2H2.2z'), P('M4.3 10V6l1.7 2 1.7-2v4')]),
			all: makeIcon([P('M3.4 4.5h9.2M3.4 8h9.2M3.4 11.5h9.2')])
		};

		/* -------------------------------------------------------------- utils */

		const joinRel = (dir, name) => (dir === '' ? name : `${dir}/${name}`);
		const parentRel = (rel) => {
			const at = rel.lastIndexOf('/');
			return at < 0 ? '' : rel.slice(0, at);
		};
		const baseName = (rel) => {
			const at = rel.lastIndexOf('/');
			return at < 0 ? rel : rel.slice(at + 1);
		};
		const extOf = (name) => {
			const at = name.lastIndexOf('.');
			return at <= 0 ? '' : name.slice(at + 1).toLowerCase();
		};
		/* The panel browses one workspace, so an absolute path is just the root
		 * with the relative path stuck on; the root itself has no trailing slash. */
		const absOf = (root, rel) => {
			const base = typeof root === 'string' ? root.replace(/\/+$/, '') : '';
			if (typeof rel !== 'string' || rel === '') return base;
			return `${base}/${rel}`;
		};

		/* The composer keeps two coordinate systems for the same document: the
		 * detect projection, where a chip is one placeholder character, and the
		 * clipboard projection, where the chip expands to its full mention text.
		 * `captureInsertion` answers in detect coordinates while published
		 * occurrences are clipboard offsets, so an insertion after any existing
		 * chip lands too early unless the offsets are converted. */
		const detectToClipboard = (occurrences, detectOffset) => {
			const list = (Array.isArray(occurrences) ? occurrences : [])
				.filter((item) => item && typeof item.offset === 'number' && typeof item.length === 'number')
				.sort((left, right) => left.offset - right.offset);
			let shift = 0;
			let convert = 0;
			for (const item of list) {
				const chipDetectStart = item.offset - shift;
				const chipDetectEnd = chipDetectStart + 1;
				if (chipDetectEnd <= detectOffset) convert += item.length - 1;
				shift += item.length - 1;
			}
			return detectOffset + convert;
		};

		/* Mirror of the composer's own draft snapshot guard: references must be
		 * ordered, non-overlapping, and each must reproduce its clipboard text at
		 * its offset. Anything else is rejected wholesale, which would silently
		 * drop every chip, so the caller re-plans instead of trusting the math. */
		const draftIsValid = (text, references) => {
			let end = 0;
			for (const reference of references) {
				if (reference.offset < end) return false;
				if (typeof reference.clipboardText !== 'string') return false;
				if (reference.length !== reference.clipboardText.length) return false;
				end = reference.offset + reference.length;
				if (end > text.length) return false;
				if (text.slice(reference.offset, end) !== reference.clipboardText) return false;
			}
			return true;
		};

		/* Browser word selection is per text node, so a syntax-highlighted preview
		 * splits `let total = 0` into four spans and a double click can never span
		 * them. These three helpers reproduce the native behaviour over the whole
		 * rendered text instead of one span. */
		const wordClassAt = (text, at) => {
			const ch = text.charAt(at);
			if (ch === '') return '';
			if (/\s/.test(ch)) return 'space';
			if (/[A-Za-z0-9_$]/.test(ch) || /[\u00c0-\u024f\u4e00-\u9fff]/.test(ch)) return 'word';
			return 'punct';
		};

		const expandWordAt = (text, at) => {
			if (text === '') return null;
			let index = at;
			if (index >= text.length) index = text.length - 1;
			if (index < 0) return null;
			const cls = wordClassAt(text, index);
			/* Blank space keeps the browser's own selection: a double click there
			 * means "this gap", not "the word next to it". */
			if (cls === 'space') return null;
			let start = index;
			while (start > 0 && wordClassAt(text, start - 1) === cls) start -= 1;
			let end = index + 1;
			while (end < text.length && wordClassAt(text, end) === cls) end += 1;
			return { start, end };
		};

		const expandLineAt = (text, at) => {
			if (text === '') return null;
			const index = Math.max(0, Math.min(at, text.length));
			const start = text.lastIndexOf('\n', index - 1) + 1;
			let end = text.indexOf('\n', index);
			if (end < 0) end = text.length;
			if (start === end) return null;
			return { start, end };
		};

		const textOffsetOf = (rootNode, node, offset) => {
			if (!rootNode || !node) return null;
			let total = 0;
			const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT, null);
			let current = walker.nextNode();
			while (current !== null) {
				if (current === node) return total + Math.max(0, Math.min(offset, current.nodeValue.length));
				total += current.nodeValue.length;
				current = walker.nextNode();
			}
			return null;
		};

		const pointOfTextOffset = (rootNode, offset) => {
			let total = 0;
			const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT, null);
			let current = walker.nextNode();
			let last = null;
			while (current !== null) {
				const length = current.nodeValue.length;
				if (offset <= total + length) return { node: current, offset: Math.max(0, offset - total) };
				total += length;
				last = current;
				current = walker.nextNode();
			}
			return last === null ? null : { node: last, offset: last.nodeValue.length };
		};

		const applyTextSelection = (rootNode, start, end) => {
			if (!rootNode || typeof window === 'undefined') return false;
			const from = pointOfTextOffset(rootNode, start);
			const to = pointOfTextOffset(rootNode, end);
			if (from === null || to === null) return false;
			const selection = window.getSelection();
			if (!selection) return false;
			const range = document.createRange();
			range.setStart(from.node, from.offset);
			range.setEnd(to.node, to.offset);
			selection.removeAllRanges();
			selection.addRange(range);
			return true;
		};

		const ARCHIVE_EXT = new Set(['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'bz2', 'xz', 'zst']);
		const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);
		const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
		const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac']);
		const TEXT_EXT = new Set([
			'txt', 'md', 'markdown', 'json', 'jsonc', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss',
			'less', 'html', 'htm', 'xml', 'svg', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'sh',
			'bash', 'zsh', 'fish', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php',
			'sql', 'graphql', 'gql', 'vue', 'svelte', 'astro', 'lua', 'r', 'swift', 'dart', 'dockerfile',
			'gitignore', 'editorconfig', 'lock', 'log', 'csv', 'tsv'
		]);

		/** Files the previewer renders as formatted Markdown instead of source. */
		const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx']);
		/** Files the previewer renders in a script-disabled sandboxed frame. */
		const HTML_EXT = new Set(['html', 'htm']);

		/* The Markdown parser and the HTML rewriter are far heavier than the
		 * tokenizer that drives the source view, and the previewer happily reads
		 * up to 512 KB. Past this size a document stays in the source view — the
		 * toggle is withheld rather than offered and then hanging the UI. */
		const RENDER_LIMIT = 200000;

		function gutterText(text) {
			const count = text === '' ? 1 : text.split('\n').length;
			let out = '1';
			for (let n = 2; n <= count; n += 1) out += '\n' + n;
			return out;
		}

		/* A relative image reference inside a Markdown file is resolved against
		 * that file's own directory, exactly like a static site generator would.
		 * Absolute URLs and data/blob URIs are left for the browser to handle. */
		function resolveRelativeAsset(rel, value) {
			const target = typeof value === 'string' ? value.trim() : '';
			if (target === '' || target.startsWith('/')) return undefined;
			if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.startsWith('#')) return undefined;
			const dir = parentRel(rel);
			const parts = (dir === '' ? target : `${dir}/${target}`).split('/');
			const stack = [];
			for (const part of parts) {
				if (part === '' || part === '.') continue;
				if (part === '..') {
					if (stack.length === 0) return undefined;
					stack.pop();
				} else stack.push(part);
			}
			return stack.length === 0 ? undefined : stack.join('/');
		}

		function sizeLabel(bytes) {
			if (typeof bytes !== 'number' || Number.isNaN(bytes)) return '';
			if (bytes < 1024) return `${bytes} B`;
			const units = ['KB', 'MB', 'GB', 'TB'];
			let value = bytes / 1024;
			let index = 0;
			while (value >= 1024 && index < units.length - 1) {
				value /= 1024;
				index += 1;
			}
			return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
		}

		function categoryOf(name) {
			const ext = extOf(name);
			if (IMAGE_EXT.has(ext)) return 'image';
			if (VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext)) return 'media';
			if (ARCHIVE_EXT.has(ext)) return 'archive';
			if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'html', 'htm', 'vue', 'svelte', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'sql', 'lua'].includes(ext)) return 'code';
			if (['json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'md', 'markdown', 'txt', 'log', 'csv'].includes(ext)) return 'doc';
			if (ext === 'pdf') return 'pdf';
			return 'file';
		}

		const CATEGORY_COLOR = {
			image: 'var(--dsw-alias-brand-primary)',
			media: 'var(--dsw-alias-state-error-primary)',
			archive: 'var(--dsw-alias-label-primary)',
			code: 'var(--dsw-alias-link)',
			doc: 'var(--dsw-alias-label-secondary)',
			pdf: 'var(--dsw-alias-state-error-primary)',
			file: 'var(--dsw-alias-label-tertiary)'
		};

		/* The Web UI may be mounted under a gateway prefix (for example
		 * `/app/fn-deepseek-harness/`). Absolute `/api/...` URLs would escape
		 * that prefix, so every route is resolved against the application base. */
		function appBase() {
			const declared = document.querySelector('base[href]');
			if (declared) return new URL(declared.getAttribute('href'), document.baseURI);
			const pathname = location.pathname;
			if (pathname.endsWith('/')) return new URL(pathname, location.origin);
			const last = pathname.slice(pathname.lastIndexOf('/') + 1);
			if (last.includes('.')) return new URL(pathname.slice(0, pathname.lastIndexOf('/') + 1), location.origin);
			return new URL(`${pathname}/`, location.origin);
		}

		function apiUrl(relative, params) {
			const url = new URL(relative, appBase());
			if (params !== void 0) {
				for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
			}
			return url;
		}

		async function op(name, payload) {
			const response = await fetch(apiUrl('api/fm/op'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op: name, ...payload })
			});
			let data;
			try {
				data = await response.json();
			} catch {
				throw new Error(`HTTP ${response.status}`);
			}
			if (data === null || typeof data !== 'object' || data.ok !== true) {
				const error = new Error(data && data.error ? data.error.message : `HTTP ${response.status}`);
				error.code = data && data.error ? data.error.code : 'http';
				throw error;
			}
			return data.value;
		}

		function uploadUrl(root, dirRel, name) {
			return apiUrl('api/fm/upload', { root, dir: dirRel, name }).toString();
		}

		function downloadUrl(root, rel, inline) {
			const params = { root, rel };
			if (inline) params.inline = '1';
			return apiUrl('api/fm/download', params).toString();
		}

		function fileAddress(sessionId, rel) {
			const path = rel === '' ? '' : rel.split('/').map((part) => encodeURIComponent(part)).join('/');
			return `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${path}`;
		}

		function mentionOf(rel, isDirectory) {
			if (/[\u0000-\u001f\u007f-\u009f"]/u.test(rel)) return null;
			const path = isDirectory ? `${rel}/` : rel;
			if (/\s/u.test(path)) return isDirectory ? `@"${path}` : `@"${path}"`;
			return `@${path}`;
		}

		async function copyPlainText(text) {
			if (text === '') return false;
			const board = typeof navigator === 'undefined' ? null : navigator.clipboard;
			if (board && typeof board.writeText === 'function') {
				try {
					await board.writeText(text);
					return true;
				} catch (error) {
					/* fall through to the legacy path */
				}
			}
			try {
				const area = document.createElement('textarea');
				area.value = text;
				area.setAttribute('readonly', '');
				area.style.position = 'fixed';
				area.style.top = '-1000px';
				area.style.opacity = '0';
				document.body.appendChild(area);
				area.select();
				const ok = document.execCommand('copy');
				document.body.removeChild(area);
				return ok === true;
			} catch (error) {
				return false;
			}
		}

		/* Server errors carry a stable `code` and an English `message`. Codes we know
		 * are translated here so a Chinese UI never shows a raw English sentence; an
		 * unknown code still shows the server text, which beats a generic failure. */
		function describeError(error, t) {
			const code = error && typeof error.code === 'string' ? error.code : '';
			const key = `err.${code}`;
			const known = code === '' ? key : t(key);
			if (known !== key) return known;
			const message = error && typeof error.message === 'string' ? error.message : '';
			return message === '' ? t('err.unknown') : message;
		}

		function codeError(data, status) {
			const error = new Error(data && data.error ? data.error.message : `HTTP ${status}`);
			error.code = data && data.error && typeof data.error.code === 'string' ? data.error.code : 'http';
			return error;
		}

		/* ------------------------------------------------------------ locales */

		const zh = {
			'type.label': '文件',
			noWorkspace: '这个会话没有工作区目录。',
			loading: '正在读取…',
			empty: '空目录',
			loadFailed: '读取失败：{message}',
			truncated: '条目过多，仅显示前一部分。',
			root: '工作区',
			newFile: '新建文件',
			newFolder: '新建文件夹',
			upload: '上传文件',
			uploadFolder: '上传文件夹',
			refresh: '刷新',
			showHidden: '显示隐藏文件',
			search: '搜索',
			closeSearch: '关闭搜索',
			searchPlaceholder: '搜索已加载的文件和文件夹',
			clearSearch: '清除搜索',
			noMatches: '没有匹配项',
			copyPath: '复制相对路径',
			copyAbsPath: '复制绝对路径',
			copyFailed: '复制失败',
			copyName: '复制文件名',
			pathCopied: '已复制路径',
			hideHidden: '隐藏点文件',
			composerBusy: '输入框正在处理上一条消息',
			more: '更多操作',
			jumpTo: '跳转到',
			useRoot: '切换到此目录',
			selectedCount: '已选 {count} 项',
			clearSelection: '取消选择',
			copy: '复制',
			cut: '剪切',
			paste: '粘贴',
			pasteHere: '粘贴到「{name}」',
			compressZip: '压缩为 ZIP',
			compressTar: '压缩为 tar.gz',
			extract: '解压',
			extractHere: '解压到「{name}」',
			download: '下载',
			rename: '重命名',
			delete: '删除',
			preview: '预览',
			edit: '编辑',
			openInPanel: '在预览面板打开',
			openFolder: '打开',
			save: '保存',
			close: '关闭',
			saved: '已保存',
			saving: '保存中…',
			saveHint: 'Ctrl+S 保存',
			unsaved: '未保存',
			conflictTitle: '文件已被修改',
			conflictMessage: '这个文件在打开之后被外部修改了。仍要用当前内容覆盖吗？',
			overwrite: '覆盖保存',
			cancel: '取消',
			confirm: '确定',
			create: '创建',
			deleteTitle: '删除确认',
			deleteMessage: '确定删除选中的 {count} 项吗？此操作不可撤销。',
			deleteDirNote: '目录会连同其中的内容一起删除。',
			renameTitle: '重命名',
			newFileTitle: '新建文件',
			newFolderTitle: '新建文件夹',
			defaultFileName: '未命名文件.txt',
			defaultFolderName: '新建文件夹',
			created: '已创建 {name}',
			discardChanges: '有未保存的修改，确定关闭吗？',
			nameLabel: '名称',
			invalidName: '名称不能为空，也不能包含 / 或 \\。',
			copied: '已复制 {count} 项',
			cutDone: '已剪切 {count} 项',
			pasted: '已粘贴 {count} 项',
			copiedText: '已复制到剪贴板',
			cutText: '已剪切到剪贴板',
			pastedText: '已粘贴',
			pasteFailed: '粘贴失败：无法读取系统剪贴板',
			compressed: '已生成 {name}',
			extracted: '已解压到 {name}',
			deleted: '已删除 {count} 项',
			renamed: '已重命名',
			uploading: '正在上传 {name}…',
			uploadedMany: '已上传 {count} 个文件',
			dropHint: '松开以上传到当前目录',
			binaryFile: '二进制文件，无法以文本编辑。',
			largeFile: '文件超过 2 MB，仅加载了开头部分，编辑已禁用。',
			previewUnavailable: '无法预览此类型，请下载后查看。',
			itemsCount: '{count} 项',
			foldersCount: '{count} 个文件夹',
			clipboardCut: '已剪切 {count} 项',
			clipboardCopy: '已复制 {count} 项',
			downloadStarted: '开始下载',
			compressing: '正在压缩…',
			extracting: '正在解压…',
			deleting: '正在删除…',
			working: '处理中…',
			linesCount: '{count} 行',
			noPreview: '没有可预览的内容',
			openFailed: '打开失败：{message}',
			selectionArchive: '打包下载',
			maxUpload: '一次最多上传 {count} 个文件',
			addToChat: '添加到对话',
			addToChatMany: '添加 {count} 项到对话',
			addedToChat: '已添加到对话',
			addToChatFailed: '添加失败：{message}',
			noComposer: '当前会话没有可写入的输入框',
			copySelection: '复制所选文本',
			selectAll: '全选',
			addToChatSelection: '添加所选文本到对话',
			addFileToChat: '把这个文件添加到对话',
			'err.unknown': '操作失败',
			'err.bad-path': '路径不合法',
			'err.bad-name': '名称不合法',
			'err.bad-request': '请求不合法',
			'err.not-found': '目标不存在',
			'err.not-a-file': '这不是一个文件',
			'err.not-directory': '目标不是目录',
			'err.is-a-directory': '这是一个目录',
			'err.not-a-directory': '路径中有一段不是目录',
			'err.not-empty': '目录不是空的',
			'err.denied': '没有权限',
			'err.no-space': '磁盘空间不足',
			'err.too-many-files': '打开的文件过多',
			'err.outside': '目标不在工作区内',
			'err.exists': '同名文件或目录已存在',
			'err.conflict': '文件已被外部修改',
			'err.archive-failed': '压缩或解压失败',
			'err.io': '读写失败',
			attachedTitle: '对话中：',
			detachHint: '从对话中移除 {name}',
			mdRendered: '渲染',
			mdRaw: '源码',
			codeCopy: '复制',
			codeCopied: '已复制',
			codeLabel: '代码块',
			codeWrap: '自动换行',
			codeUnwrap: '取消换行',
			footnotesLabel: '脚注'
		};

		const en = {
			'type.label': 'Files',
			noWorkspace: 'This session has no workspace directory.',
			loading: 'Reading…',
			empty: 'Empty directory',
			loadFailed: 'Read failed: {message}',
			truncated: 'Too many entries; only the first part is shown.',
			root: 'Workspace',
			newFile: 'New file',
			newFolder: 'New folder',
			upload: 'Upload files',
			uploadFolder: 'Upload folder',
			refresh: 'Refresh',
			showHidden: 'Show hidden files',
			search: 'Search',
			closeSearch: 'Close search',
			searchPlaceholder: 'Filter loaded files and folders',
			clearSearch: 'Clear search',
			noMatches: 'No matches',
			copyPath: 'Copy relative path',
			copyAbsPath: 'Copy absolute path',
			copyFailed: 'Copy failed',
			copyName: 'Copy file name',
			pathCopied: 'Path copied',
			hideHidden: 'Hide dot files',
			composerBusy: 'The composer is still finishing the last message',
			more: 'More actions',
			jumpTo: 'Jump to',
			useRoot: 'Switch to this folder',
			selectedCount: '{count} selected',
			clearSelection: 'Clear selection',
			copy: 'Copy',
			cut: 'Cut',
			paste: 'Paste',
			pasteHere: 'Paste into “{name}”',
			compressZip: 'Compress to ZIP',
			compressTar: 'Compress to tar.gz',
			extract: 'Extract',
			extractHere: 'Extract into “{name}”',
			download: 'Download',
			rename: 'Rename',
			delete: 'Delete',
			preview: 'Preview',
			edit: 'Edit',
			openInPanel: 'Open in preview panel',
			openFolder: 'Open',
			save: 'Save',
			close: 'Close',
			saved: 'Saved',
			saving: 'Saving…',
			saveHint: 'Ctrl+S to save',
			unsaved: 'Unsaved',
			conflictTitle: 'File changed',
			conflictMessage: 'This file was modified outside the editor after it was opened. Overwrite it with the current content?',
			overwrite: 'Overwrite',
			cancel: 'Cancel',
			confirm: 'OK',
			create: 'Create',
			deleteTitle: 'Delete',
			deleteMessage: 'Delete the {count} selected item(s)? This cannot be undone.',
			deleteDirNote: 'Directories are deleted with everything inside them.',
			renameTitle: 'Rename',
			newFileTitle: 'New file',
			newFolderTitle: 'New folder',
			defaultFileName: 'untitled.txt',
			defaultFolderName: 'New folder',
			created: 'Created {name}',
			discardChanges: 'There are unsaved changes. Close anyway?',
			nameLabel: 'Name',
			invalidName: 'The name must not be empty or contain / or \\.',
			copied: 'Copied {count} item(s)',
			cutDone: 'Cut {count} item(s)',
			pasted: 'Pasted {count} item(s)',
			copiedText: 'Copied to clipboard',
			cutText: 'Cut to clipboard',
			pastedText: 'Pasted',
			pasteFailed: 'Could not read the clipboard',
			compressed: 'Created {name}',
			extracted: 'Extracted into {name}',
			deleted: 'Deleted {count} item(s)',
			renamed: 'Renamed',
			uploading: 'Uploading {name}…',
			uploadedMany: 'Uploaded {count} file(s)',
			dropHint: 'Drop to upload into the current folder',
			binaryFile: 'Binary file; it cannot be edited as text.',
			largeFile: 'This file is larger than 2 MB. Only the beginning was loaded, so editing is disabled.',
			previewUnavailable: 'This type cannot be previewed here. Download it instead.',
			itemsCount: '{count} item(s)',
			foldersCount: '{count} folder(s)',
			clipboardCut: 'Cut {count} item(s)',
			clipboardCopy: 'Copied {count} item(s)',
			downloadStarted: 'Download started',
			compressing: 'Compressing…',
			extracting: 'Extracting…',
			deleting: 'Deleting…',
			working: 'Working…',
			linesCount: '{count} lines',
			noPreview: 'Nothing to preview',
			openFailed: 'Could not open: {message}',
			selectionArchive: 'Download as ZIP',
			maxUpload: 'At most {count} files at a time',
			addToChat: 'Add to chat',
			addToChatMany: 'Add {count} items to chat',
			addedToChat: 'Added to chat',
			addToChatFailed: 'Could not add: {message}',
			noComposer: 'This session has no writable composer',
			copySelection: 'Copy selected text',
			selectAll: 'Select all',
			addToChatSelection: 'Add selected text to chat',
			addFileToChat: 'Add this file to chat',
			'err.unknown': 'The operation failed',
			'err.bad-path': 'Invalid path',
			'err.bad-name': 'Invalid name',
			'err.bad-request': 'Invalid request',
			'err.not-found': 'The target does not exist',
			'err.not-a-file': 'That is not a file',
			'err.not-directory': 'The target is not a directory',
			'err.is-a-directory': 'That is a directory',
			'err.not-a-directory': 'A path component is not a directory',
			'err.not-empty': 'The directory is not empty',
			'err.denied': 'Permission denied',
			'err.no-space': 'No space left on the device',
			'err.too-many-files': 'Too many open files',
			'err.outside': 'The target is outside the workspace',
			'err.exists': 'An entry with that name already exists',
			'err.conflict': 'The file changed outside the editor',
			'err.archive-failed': 'Compression failed',
			'err.io': 'Read or write failed',
			attachedTitle: 'In chat:',
			detachHint: 'Remove {name} from the chat',
			mdRendered: 'Rendered',
			mdRaw: 'Source',
			codeCopy: 'Copy',
			codeCopied: 'Copied',
			codeLabel: 'Code block',
			codeWrap: 'Wrap lines',
			codeUnwrap: 'Unwrap lines',
			footnotesLabel: 'Footnotes'
		};

		/* --------------------------------------------------------------- css */

		const CSS = `
.fm-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5;outline:none}
.fm-header{display:flex;align-items:center;gap:1px;padding:6px 5px 6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none;min-height:38px;box-sizing:border-box}
.fm-crumbs{flex:1;min-width:0;display:flex;align-items:center;gap:0;overflow:hidden;white-space:nowrap}
.fm-tool.on{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.fm-searchbar{display:flex;align-items:center;gap:6px;padding:5px 8px 5px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none;color:var(--dsw-alias-label-tertiary)}
.fm-search{flex:1;min-width:0;font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary);background:transparent;border:none;outline:none;padding:2px 0}
.fm-search::placeholder{color:var(--dsw-alias-label-tertiary)}
.fm-searchcount{font-size:11.5px;color:var(--dsw-alias-label-tertiary);flex:none;font-variant-numeric:tabular-nums}
.fm-mih{padding:5px 10px 3px;font-size:11px;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em;user-select:none}
.fm-crumb{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;padding:2px 4px;border-radius:4px;cursor:pointer;max-width:130px;overflow:hidden;text-overflow:ellipsis;flex:none}
.fm-crumb:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.fm-crumb.current{color:var(--dsw-alias-label-primary);font-weight:500}
.fm-sep{color:var(--dsw-alias-label-tertiary);flex:none;font-size:11px}
.fm-tool{width:26px;height:26px;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm,5px);cursor:pointer;background:transparent;border:none;flex:none;justify-content:center;align-items:center;padding:0;line-height:1;display:inline-flex}
.fm-tool svg{width:15px;height:15px}
.fm-tool:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.fm-tool:disabled{opacity:.35;cursor:default}
/* Sits below the scroll box, so its border faces the list it summarises. */
.fm-selbar{display:flex;align-items:center;gap:1px;padding:2px 5px 2px 10px;border-top:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);flex:none}
.fm-seltext{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm-body{flex:1;min-height:0;overflow:auto;padding:5px 4px 10px;scrollbar-gutter:stable;outline:none}
.fm-row{display:flex;align-items:center;gap:5px;height:26px;padding:0 8px 0 2px;border-radius:5px;cursor:default;user-select:none;white-space:nowrap;box-sizing:border-box}
.fm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fm-row.selected{background:var(--dsw-alias-interactive-bg-active)}
.fm-row.selected:hover{background:var(--dsw-alias-interactive-bg-active)}
.fm-row.cut{opacity:.45}
.fm-row.dropTarget{outline:1px dashed var(--dsw-alias-brand-primary);outline-offset:-1px}
.fm-chev{width:15px;height:15px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);flex:none;border:0;background:transparent;padding:0;cursor:pointer;border-radius:3px}
.fm-chev:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.fm-chev svg{width:12px;height:12px}
.fm-spacer{width:15px;flex:none}
.fm-glyph{width:17px;height:17px;flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);font-size:7.5px;font-weight:600;letter-spacing:.2px;text-transform:uppercase;overflow:hidden;line-height:1}
.fm-glyph.dir{background:transparent;width:17px;font-size:0}
.fm-glyph.dir svg{width:16px;height:16px;color:var(--dsw-alias-brand-primary)}
.fm-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.fm-name.dim{color:var(--dsw-alias-label-tertiary)}
.fm-size{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums;padding-left:6px}
.fm-note{padding:3px 8px 3px 22px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.fm-note.error{color:var(--dsw-alias-state-error-primary)}
.fm-footer{flex:none;display:flex;gap:8px;align-items:center;padding:4px 10px;border-top:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap;overflow:hidden}
.fm-flex{flex:1;min-width:0}
.fm-clip{color:var(--dsw-alias-brand-primary);overflow:hidden;text-overflow:ellipsis}
/* Chips mirror the composer's own reference chip so a file attached from this
 * panel looks identical to one picked with the @ menu in the input box. */
.fm-chips{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:5px;max-height:78px;overflow:auto;padding:5px 8px;border-top:.5px solid var(--dsw-alias-border-l3)}
.fm-chipshead{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);margin-right:1px}
.fm-chip{display:inline-flex;align-items:baseline;gap:3px;max-width:240px;padding:1px 5px;border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:12px;line-height:1.6;cursor:pointer}
.fm-chip:hover{background:var(--dsw-alias-state-business-tertiary)}
.fm-chiplabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm-chipx{flex:none;display:inline-flex;align-self:center;opacity:0;margin-left:1px}
.fm-chip:hover .fm-chipx,.fm-chip:focus-visible .fm-chipx{opacity:.75}
.fm-overlay{position:absolute;inset:0;z-index:20;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);min-height:0}
.fm-ovhead{display:flex;align-items:center;gap:1px;padding:5px 5px 5px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none;min-height:38px;box-sizing:border-box}
.fm-ovtitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.fm-ovsub{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;padding-right:4px}
.fm-editwrap{flex:1;min-height:0;display:flex;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.fm-editor{flex:1;min-height:0;width:100%;box-sizing:border-box;border:0;outline:none;resize:none;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.6;tab-size:2;white-space:pre;overflow:auto}
.fm-gutter{margin:0;padding:10px 8px 10px 10px;text-align:right;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1);border-right:1px solid var(--dsw-alias-border-l1);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.6;white-space:pre;overflow:hidden;user-select:none;flex:none}
.fm-codescroll{flex:1;min-height:0;width:100%;height:100%;display:flex;overflow:auto;background:var(--dsw-alias-bg-layer-1)}
/* The preview gutter shares the scroll box as a flex row. Without align-self
 * the flex default (stretch) pins it to the port height — 799px — while the
 * text beside it is 6040px tall, and overflow:hidden then clips every number
 * past the first screen: 301 lines showed only 38 numbers. flex-start lets the
 * gutter take its natural full height so every number exists, and vertical
 * scrolling then carries it along with the text; left keeps it pinned when the
 * text scrolls sideways. Keep this comment free of backticks — it lives inside
 * a template literal. */
.fm-codescroll>.fm-gutter{position:sticky;left:0;z-index:1;align-self:flex-start;overflow:visible}
.fm-pre{flex:1;min-height:0;margin:0;overflow:visible;padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.6;white-space:pre;tab-size:2;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);user-select:text;-webkit-user-select:text;cursor:text}
.fm-editbody{position:relative;flex:1;min-height:0;min-width:0;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.fm-hl{position:absolute;inset:0;margin:0;padding:10px 12px;overflow:hidden;pointer-events:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.6;tab-size:2;white-space:pre;background:transparent;color:var(--dsw-alias-label-primary);z-index:0}
.fm-editbody>.fm-editor{position:absolute;inset:0;width:100%;height:100%;z-index:1;background:transparent;color:transparent;caret-color:var(--dsw-alias-label-primary)}
.fm-editbody>.fm-editor.fm-plain{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.fm-editbody>.fm-editor::selection{background:var(--dsw-alias-bg-document-selection);color:transparent}
.fm-editbody>.fm-editor.fm-plain::selection{color:inherit}
.fm-tk-kw{color:var(--dsw-alias-link)}
.fm-tk-str{color:var(--dsw-static-green-900)}
.fm-tk-num{color:var(--dsw-alias-state-warn-label)}
.fm-tk-cmt{color:var(--dsw-alias-label-tertiary);font-style:italic}
.fm-tk-fn{color:var(--dsw-static-deepseek-600)}
.fm-tk-type{color:var(--dsw-alias-state-business-primary)}
.fm-tk-lit{color:var(--dsw-alias-state-error-primary)}
.fm-tk-ann{color:var(--dsw-alias-state-warn-label)}
.fm-tk-prop{color:var(--dsw-alias-state-business-primary)}
.fm-tk-tag{color:var(--dsw-alias-state-business-primary)}
.fm-tk-attr{color:var(--dsw-static-amber-600)}
.fm-tk-head{color:var(--dsw-alias-label-primary);font-weight:600}
.fm-tk-quote{color:var(--dsw-alias-label-secondary);font-style:italic}
.fm-tk-bullet{color:var(--dsw-alias-state-business-primary)}
.fm-tk-hr{color:var(--dsw-alias-label-tertiary)}
.fm-tk-link{color:var(--dsw-alias-link);text-decoration:underline}
.fm-tk-strong{font-weight:600;color:var(--dsw-alias-label-primary)}
.fm-tk-em{font-style:italic}
.fm-tk-code{color:var(--dsw-static-deepseek-600)}
body[data-ds-dark-theme] .fm-tk-str{color:var(--dsw-static-green-400)}
body[data-ds-dark-theme] .fm-tk-num,body[data-ds-dark-theme] .fm-tk-attr,body[data-ds-dark-theme] .fm-tk-ann{color:var(--dsw-static-amber-400)}
body[data-ds-dark-theme] .fm-tk-fn,body[data-ds-dark-theme] .fm-tk-code{color:var(--dsw-static-deepseek-300)}
.fm-previewbody{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:auto;background:var(--dsw-alias-bg-layer-1)}
/* Markdown fills the pane and scrolls as a document, unlike an image which is
 * centred and capped. The inner body is the host renderer's own wrapper, so
 * only spacing and a readable measure are set here — type, headings, tables
 * and code fences keep the chat's tokens so both surfaces stay identical. */
.fm-mdscroll{flex:1;align-self:stretch;min-height:0;width:100%;height:100%;overflow:auto;background:var(--dsw-alias-bg-layer-1)}
.fm-mdbody{max-width:var(--dsh-chat-content-width,748px);margin:0 auto;padding:16px 20px 48px;box-sizing:border-box;font-size:var(--dsh-content-font-size-secondary,13px)}
.fm-mdbody>:first-child{margin-top:0}
.fm-mdbody>:last-child{margin-bottom:0}
.fm-mdbody :where(pre){overflow:auto;max-width:100%}
.fm-mdbody :where(table){max-width:100%;display:block;overflow-x:auto}
.fm-mdbody :where(img){max-width:100%;height:auto}
.fm-previewbody img{max-width:100%;max-height:100%;object-fit:contain;display:block}
.fm-previewbody iframe{width:100%;height:100%;border:0;background:var(--dsw-alias-bg-base)}
/* The HTML preview fills the pane like the PDF frame: full-bleed, own scroll.
 * Unlike an image it is never centred or capped — a document is a document. */
.fm-htmlframe{flex:1;align-self:stretch;min-height:0;width:100%;height:100%;border:0;background:var(--dsw-alias-bg-base)}
.fm-previewbody video,.fm-previewbody audio{max-width:calc(100% - 24px);max-height:100%}
.fm-info{display:flex;flex-direction:column;align-items:center;gap:8px;padding:24px;color:var(--dsw-alias-label-secondary);text-align:center;font-size:12px;line-height:1.6}
.fm-info svg{width:30px;height:30px;color:var(--dsw-alias-label-tertiary)}
.fm-menu{position:fixed;z-index:50;min-width:200px;max-height:70vh;overflow:auto;padding:4px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);box-shadow:0 8px 24px rgba(0,0,0,.18)}
.fm-mi{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:6px 8px;border-radius:5px;cursor:default;text-align:left;white-space:nowrap}
.fm-mi:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.fm-mi.danger{color:var(--dsw-alias-state-error-primary)}
.fm-mi.danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}
.fm-mi:disabled{opacity:.4}
.fm-mi svg{width:14px;height:14px;flex:none;color:var(--dsw-alias-label-secondary)}
.fm-mi.danger svg{color:inherit}
.fm-kbd{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;padding-left:14px}
.fm-div{height:.5px;background:var(--dsw-alias-border-l3);margin:4px 6px}
.fm-scrim{position:absolute;inset:0;z-index:40;background:var(--dsw-alias-bg-mask-1);display:flex;align-items:flex-start;justify-content:center;padding:44px 12px}
.fm-dialog{width:100%;max-width:340px;max-height:calc(100% - 88px);overflow:auto;border-radius:10px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);box-shadow:0 12px 32px rgba(0,0,0,.22);padding:14px;box-sizing:border-box}
.fm-dtitle{font-weight:600;margin:0 0 6px}
.fm-dmsg{color:var(--dsw-alias-label-secondary);margin:0 0 10px;white-space:pre-wrap}
.fm-input{width:100%;box-sizing:border-box;font:inherit;padding:6px 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);outline:none}
.fm-input:focus{border-color:var(--dsw-alias-brand-primary)}
.fm-error{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:6px 0 0}
.fm-dactions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.fm-btn{font:inherit;font-size:13px;padding:5px 12px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.fm-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fm-btn.primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
.fm-btn.primary:hover{background:var(--dsw-alias-button-primary-hover)}
.fm-btn.danger{background:var(--dsw-alias-state-error-primary);border-color:transparent;color:#fff;font-weight:600}
.fm-btn.danger:hover{background:var(--dsw-alias-state-error-secondary);color:#fff}
.fm-toast{position:absolute;left:10px;right:10px;bottom:10px;z-index:60;padding:7px 10px;border-radius:7px;background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l2);box-shadow:0 6px 20px rgba(0,0,0,.18);font-size:12px;display:flex;gap:8px;align-items:center;word-break:break-word}
.fm-toast.error{color:var(--dsw-alias-state-error-primary)}
.fm-busy{position:absolute;inset:0;z-index:55;background:var(--dsw-alias-bg-mask-1);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:9px;font-size:12px;color:var(--dsw-alias-label-secondary);padding:16px;text-align:center;word-break:break-word}
.fm-spinner{width:18px;height:18px;border:2px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:fm-spin .8s linear infinite}
@keyframes fm-spin{to{transform:rotate(360deg)}}
.fm-drop{position:absolute;inset:0;z-index:54;border:2px dashed var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-mask-drop);display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary);font-size:13px;pointer-events:none}
.fm-emptyTitle{display:flex;align-items:center;gap:6px;font-weight:500}
.fm-title{display:inline-flex;align-items:center;gap:6px;min-width:0}
.fm-title svg{width:16px;height:16px;flex:none}
`;

		/* ---------------------------------------------------------- fragments */

		function Glyph({ name, type }) {
			if (type === 'directory') {
				return h('span', { className: 'fm-glyph dir' }, h(I.folder, { size: 16 }));
			}
			const ext = extOf(name);
			const label = ext === '' ? '·' : ext.slice(0, 3);
			const color = CATEGORY_COLOR[categoryOf(name)];
			return h('span', { className: 'fm-glyph', style: { color }, title: ext ? `.${ext}` : undefined }, label);
		}

		function Row({ row, selected, cut, dropTarget, onClick, onDoubleClick, onContextMenu, onEnter, t }) {
			const isDir = row.type === 'directory';
			return h('div', {
				className: `fm-row${selected ? ' selected' : ''}${cut ? ' cut' : ''}${dropTarget ? ' dropTarget' : ''}`,
				style: { paddingLeft: 2 + row.depth * 14 },
				role: 'treeitem',
				'aria-selected': selected ? 'true' : 'false',
				'aria-level': row.depth + 1,
				'data-fm-path': row.rel,
				title: row.name,
				onClick,
				onDoubleClick,
				onContextMenu
			},
			isDir
				? h('button', {
					type: 'button',
					className: 'fm-chev',
					tabIndex: -1,
					'aria-label': t('openFolder'),
					onClick: (event) => {
						event.stopPropagation();
						onEnter();
					}
				}, h(I.chevron, { size: 12 }))
				: h('span', { className: 'fm-spacer' }),
			h(Glyph, { name: row.name, type: row.type }),
			h('span', { className: `fm-name${row.symlink ? ' dim' : ''}` }, row.name),
			row.type === 'file' && row.size !== undefined ? h('span', { className: 'fm-size' }, sizeLabel(row.size)) : null
			);
		}

		function Menu({ menu, items, onClose }) {
			useEffect(() => {
				const close = () => onClose();
				const onKey = (event) => {
					if (event.key === 'Escape') onClose();
				};
				const onBlur = () => onClose();
				window.addEventListener('mousedown', close);
				window.addEventListener('keydown', onKey);
				window.addEventListener('blur', onBlur);
				return () => {
					window.removeEventListener('mousedown', close);
					window.removeEventListener('keydown', onKey);
					window.removeEventListener('blur', onBlur);
				};
			}, [onClose]);
			const estimated = Math.min(items.length * 30 + 16, 380);
			const style = {
				left: Math.max(6, Math.min(menu.x, (window.innerWidth || 1200) - 214)),
				top: Math.max(6, Math.min(menu.y, (window.innerHeight || 800) - estimated - 8))
			};
			return h('div', {
				className: 'fm-menu',
				role: 'menu',
				style,
				onMouseDown: (event) => event.stopPropagation()
			}, items.map((item, index) => {
				if (item.separator) return h('div', { className: 'fm-div', key: `sep-${index}` });
				if (item.header) return h('div', { className: 'fm-mih', key: `head-${index}` }, item.header);
				const Icon = item.icon;
				return h('button', {
					key: item.key || `item-${index}`,
					type: 'button',
					role: 'menuitem',
					className: `fm-mi${item.danger ? ' danger' : ''}`,
					disabled: item.disabled === true,
					onClick: () => {
						onClose();
						item.run();
					}
				}, Icon ? h(Icon, { size: 14 }) : null, h('span', null, item.label), item.kbd ? h('span', { className: 'fm-kbd' }, item.kbd) : null);
			}));
		}

		function Dialog({ dialog, onClose, t }) {
			const [value, setValue] = useState(dialog.initial || '');
			const [error, setError] = useState('');
			const inputRef = useRef(null);
			useEffect(() => {
				if (inputRef.current) {
					inputRef.current.focus();
					inputRef.current.select();
				}
			}, []);
			const submit = () => {
				if (dialog.kind === 'prompt') {
					const trimmed = value.trim();
					if (trimmed === '' || trimmed === '.' || trimmed === '..' || /[/\\]/.test(trimmed)) {
						setError(t('invalidName'));
						return;
					}
					onClose();
					dialog.onSubmit(trimmed);
				} else {
					onClose();
					dialog.onSubmit();
				}
			};
			return h('div', {
				className: 'fm-scrim',
				onMouseDown: (event) => {
					if (event.target === event.currentTarget) onClose();
				}
			}, h('div', {
				className: 'fm-dialog',
				role: 'dialog',
				'aria-modal': 'true',
				onKeyDown: (event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						submit();
					} else if (event.key === 'Escape') {
						event.preventDefault();
						onClose();
					}
				}
			},
			h('p', { className: 'fm-dtitle', style: { margin: '0 0 8px' } }, dialog.title),
			dialog.message ? h('p', { className: 'fm-dmsg' }, dialog.message) : null,
			dialog.kind === 'prompt'
				? h('input', {
					ref: inputRef,
					className: 'fm-input',
					value,
					onChange: (event) => {
						setValue(event.target.value);
						setError('');
					},
					placeholder: dialog.placeholder || '',
					spellCheck: false,
					autoComplete: 'off'
				})
				: null,
			error ? h('p', { className: 'fm-error' }, error) : null,
			h('div', { className: 'fm-dactions' },
				h('button', { type: 'button', className: 'fm-btn', onClick: onClose }, t('cancel')),
				h('button', { type: 'button', className: `fm-btn ${dialog.danger ? 'danger' : 'primary'}`, onClick: submit }, dialog.confirmLabel || t('confirm'))
			)
			));
		}

		/* ------------------------------------------------------ highlighting */

		/* A syntax highlighter with no dependencies: the Client bundle may not
		 * import third-party packages, so the tokenizer below is a small
		 * per-language rule table driven by sticky regexes. Colours come from
		 * theme aliases only, so light and dark themes both stay readable. */

		/** Above this many characters a view degrades to plain text. */
		const HL_LIMIT = 80000;
		/** A production cap: pathological files must not spawn spans forever. */
		const HL_TOKEN_LIMIT = 40000;

		const HL_CLIKE = 'abstract|as|asserts|async|await|break|case|catch|class|const|constructor|continue|debugger|declare|default|delete|do|else|enum|export|extends|final|finally|for|from|function|get|goto|if|implements|import|in|infer|instanceof|interface|is|keyof|let|namespace|new|of|package|private|protected|public|readonly|return|satisfies|sealed|set|static|super|switch|this|throw|throws|try|type|typeof|var|void|while|with|yield';
		const HL_PY = 'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|match|nonlocal|not|or|pass|raise|return|try|while|with|yield';
		const HL_SQL = 'add|all|alter|and|as|asc|begin|between|by|case|cast|column|commit|create|cross|database|default|delete|desc|distinct|drop|else|end|exists|from|full|group|having|if|in|index|inner|insert|into|is|join|key|left|like|limit|not|null|offset|on|or|order|outer|primary|references|right|rollback|select|set|table|then|union|unique|update|using|values|view|when|where|with';

		const hlRe = (source, cls, flags) => ({ re: new RegExp(source, `y${flags || ''}`), cls });
		const hlWord = (words, cls, flags) => hlRe(`\\b(?:${words})\\b`, cls, flags);

		const CLIKE_RULES = [
			hlRe('\\/\\*[\\s\\S]*?(?:\\*\\/|$)', 'cmt'),
			hlRe('\\/\\/[^\\n]*', 'cmt'),
			hlRe('"(?:[^"\\\\\\n]|\\\\.)*"', 'str'),
			hlRe("'(?:[^'\\\\\\n]|\\\\.)*'", 'str'),
			hlRe('`(?:[^`\\\\]|\\\\.)*`', 'str'),
			hlRe('0[xX][0-9a-fA-F_]+|0[bB][01_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?', 'num'),
			hlRe('@[A-Za-z_$][\\w$]*', 'ann'),
			hlWord(HL_CLIKE, 'kw'),
			hlWord('true|false|null|undefined|NaN|Infinity', 'lit'),
			hlRe('[A-Za-z_$][\\w$]*(?=\\s*\\()', 'fn'),
			hlRe('[A-Z][A-Za-z0-9_$]*', 'type'),
			hlRe('[A-Za-z_$][\\w$]*', null),
			hlRe('\\s+', null),
			hlRe('[^\\s\\w$]+', null),
			hlRe('[\\s\\S]', null)
		];

		const HASH_RULES = [
			hlRe('#![^\\n]*', 'cmt'),
			hlRe('#[^\\n]*', 'cmt'),
			hlRe("'''[\\s\\S]*?(?:'''|$)", 'str'),
			hlRe('"""[\\s\\S]*?(?:"""|$)', 'str'),
			hlRe('"(?:[^"\\\\\\n]|\\\\.)*"', 'str'),
			hlRe("'(?:[^'\\\\\\n]|\\\\.)*'", 'str'),
			hlRe('\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?', 'num'),
			hlRe('@[A-Za-z_][\\w.]*', 'ann'),
			hlWord(HL_PY, 'kw'),
			hlWord('True|False|None|true|false|null', 'lit'),
			hlRe('(?<=def\\s+)[A-Za-z_]\\w*', 'fn'),
			hlRe('(?<=class\\s+)[A-Za-z_]\\w*', 'type'),
			hlRe('[A-Za-z_]\\w*(?=\\s*\\()', 'fn'),
			hlRe('[A-Za-z_]\\w*', null),
			hlRe('\\s+', null),
			hlRe('[^\\s\\w]+', null),
			hlRe('[\\s\\S]', null)
		];

		const CONFIG_RULES = [
			hlRe('#[^\\n]*', 'cmt'),
			hlRe('^[ \\t]*[\\w.$-]+(?=[ \\t]*[:=])', 'prop', 'm'),
			hlRe('"(?:[^"\\\\\\n]|\\\\.)*"', 'str'),
			hlRe("'(?:[^'\\\\\\n]|\\\\.)*'", 'str'),
			hlRe('\\b\\d[\\d_]*(?:\\.\\d+)?\\b', 'num'),
			hlWord('true|false|null|yes|no|on|off|True|False|None', 'lit'),
			hlRe('[A-Za-z_$][\\w.$-]*', null),
			hlRe('\\s+', null),
			hlRe('[^\\s\\w]+', null),
			hlRe('[\\s\\S]', null)
		];

		const SQL_RULES = [
			hlRe('--[^\\n]*', 'cmt'),
			hlRe('\\/\\*[\\s\\S]*?(?:\\*\\/|$)', 'cmt'),
			hlRe("'(?:[^']|'')*'", 'str'),
			hlRe('"(?:[^"]|"")*"', 'str'),
			hlWord(HL_SQL, 'kw', 'i'),
			hlWord('true|false|null', 'lit', 'i'),
			hlRe('[A-Za-z_]\\w*(?=\\s*\\()', 'fn'),
			hlRe('\\d+(?:\\.\\d+)?', 'num'),
			hlRe('[A-Za-z_]\\w*', null),
			hlRe('\\s+', null),
			hlRe('[^\\s\\w]+', null),
			hlRe('[\\s\\S]', null)
		];

		const CSS_RULES = [
			hlRe('\\/\\*[\\s\\S]*?(?:\\*\\/|$)', 'cmt'),
			hlRe('"(?:[^"\\\\\\n]|\\\\.)*"', 'str'),
			hlRe("'(?:[^'\\\\\\n]|\\\\.)*'", 'str'),
			hlRe('@[A-Za-z-]+', 'kw'),
			hlRe('#[\\da-fA-F]{3,8}\\b', 'num'),
			hlRe('[.#][A-Za-z_][\\w-]*', 'type'),
			hlRe('[A-Za-z-]+(?=\\s*:)', 'prop'),
			hlRe('[A-Za-z-]+(?=\\s*\\()', 'fn'),
			hlRe('\\d+(?:\\.\\d+)?(?:px|em|rem|vh|vw|vmin|vmax|s|ms|fr|deg|turn|%)?', 'num'),
			hlWord('important|inherit|initial|unset|auto|none|var|calc', 'lit'),
			hlRe('[A-Za-z_][\\w-]*', null),
			hlRe('\\s+', null),
			hlRe('[^\\s\\w]+', null),
			hlRe('[\\s\\S]', null)
		];

		const JSON_RULES = [
			hlRe('"(?:[^"\\\\\\n]|\\\\.)*"(?=\\s*:)', 'prop'),
			hlRe('"(?:[^"\\\\\\n]|\\\\.)*"', 'str'),
			hlRe('-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?', 'num'),
			hlWord('true|false|null', 'lit'),
			hlRe('[\\s\\S]', null)
		];

		const MARKUP_RULES = [
			hlRe('<!--[\\s\\S]*?(?:-->|$)', 'cmt'),
			hlRe('<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>|$)', 'cmt'),
			hlRe('<\\?[\\s\\S]*?(?:\\?>|$)', 'ann'),
			hlRe('</?[A-Za-z][\\w:.-]*', 'tag'),
			hlRe('/?>', 'tag'),
			hlRe('[A-Za-z_:][\\w:.-]*(?==)', 'attr'),
			hlRe('"(?:[^"]|\\n)*?"', 'str'),
			hlRe("'(?:[^']|\\n)*?'", 'str'),
			hlRe('&[A-Za-z#][\\w]*;', 'lit'),
			hlRe('[^<&]+', null),
			hlRe('[\\s\\S]', null)
		];

		const PLAIN_RULES = [hlRe('[\\s\\S]+', null)];

		const SPECS = {
			plain: PLAIN_RULES,
			clike: CLIKE_RULES,
			hash: HASH_RULES,
			config: CONFIG_RULES,
			sql: SQL_RULES,
			css: CSS_RULES,
			json: JSON_RULES,
			markup: MARKUP_RULES
		};

		const LANG_BY_EXT = {
			js: 'clike', mjs: 'clike', cjs: 'clike', jsx: 'clike', ts: 'clike', tsx: 'clike', mts: 'clike', cts: 'clike',
			java: 'clike', c: 'clike', h: 'clike', cc: 'clike', cpp: 'clike', cxx: 'clike', hpp: 'clike', cs: 'clike',
			go: 'clike', rs: 'clike', kt: 'clike', kts: 'clike', swift: 'clike', dart: 'clike', scala: 'clike', php: 'clike',
			py: 'hash', pyw: 'hash', rb: 'hash', lua: 'hash', pl: 'hash', r: 'hash',
			sh: 'hash', bash: 'hash', zsh: 'hash', fish: 'hash',
			yaml: 'config', yml: 'config', toml: 'config', ini: 'config', cfg: 'config', conf: 'config', env: 'config',
			sql: 'sql', graphql: 'sql', gql: 'sql',
			css: 'css', scss: 'css', less: 'css',
			json: 'json', jsonc: 'json',
			html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', svelte: 'markup', astro: 'markup',
			md: 'md', markdown: 'md'
		};

		const LANG_BY_NAME = {
			dockerfile: 'config',
			makefile: 'config',
			gemfile: 'hash',
			rakefile: 'hash',
			'.gitignore': 'config',
			'.editorconfig': 'config',
			'.env': 'config',
			'cmakelists.txt': 'config'
		};

		function langOf(name) {
			const base = baseName(String(name === undefined || name === null ? '' : name)).toLowerCase();
			if (LANG_BY_NAME[base] !== undefined) return LANG_BY_NAME[base];
			const ext = extOf(base);
			if (ext === '') return 'plain';
			return LANG_BY_EXT[ext] || 'plain';
		}

		const MD_INLINE = [
			hlRe('\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__', 'strong'),
			hlRe('\\*[^*\\n]+\\*', 'em'),
			hlRe('`[^`\\n]+`', 'code'),
			hlRe('!?\\[[^\\]\\n]*\\]\\([^)\\n]*\\)', 'link'),
			hlRe('<(?:https?|mailto):[^>\\n]+>', 'link')
		];

		function pushPlain(tokens, value, cls) {
			if (value === '') return;
			const previous = tokens.length > 0 ? tokens[tokens.length - 1] : null;
			if (previous !== null && previous.cls === cls) previous.value += value;
			else tokens.push({ value, cls });
		}

		function scanInline(tokens, line) {
			let index = 0;
			while (index < line.length) {
				let hit = null;
				for (let r = 0; r < MD_INLINE.length; r += 1) {
					const rule = MD_INLINE[r];
					rule.re.lastIndex = index;
					const found = rule.re.exec(line);
					if (found !== null && found.index === index) {
						hit = { value: found[0], cls: rule.cls };
						break;
					}
				}
				if (hit === null) {
					pushPlain(tokens, line[index], null);
					index += 1;
				} else {
					pushPlain(tokens, hit.value, hit.cls);
					index += hit.value.length;
				}
				if (index > line.length) break;
			}
		}

		function tokenizeMarkdown(text) {
			const tokens = [];
			const lines = text.split('\n');
			for (let i = 0; i < lines.length; i += 1) {
				const line = lines[i];
				const head = /^(#{1,6}[ \t].*)$/.exec(line);
				const fence = /^([ \t]*```.*)$/.exec(line);
				const quote = /^([ \t]*(?:>[ \t]?)+.*)$/.exec(line);
				const bullet = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)/.exec(line);
				const ruleLine = /^([ \t]*(?:---+|\*\*\*+|___+)[ \t]*)$/.exec(line);
				if (head !== null) pushPlain(tokens, head[1], 'head');
				else if (fence !== null) pushPlain(tokens, fence[1], 'kw');
				else if (quote !== null) pushPlain(tokens, quote[1], 'quote');
				else if (ruleLine !== null) pushPlain(tokens, ruleLine[1], 'hr');
				else if (bullet !== null) {
					pushPlain(tokens, bullet[1], 'bullet');
					scanInline(tokens, line.slice(bullet[1].length));
				} else scanInline(tokens, line);
				if (i + 1 < lines.length) pushPlain(tokens, '\n', null);
			}
			return tokens;
		}

		function tokenizeCode(text, lang) {
			const rules = SPECS[lang] || PLAIN_RULES;
			const tokens = [];
			let index = 0;
			while (index < text.length) {
				let value = '';
				let cls = null;
				for (let r = 0; r < rules.length; r += 1) {
					const rule = rules[r];
					rule.re.lastIndex = index;
					const found = rule.re.exec(text);
					if (found !== null && found.index === index && found[0].length > 0) {
						value = found[0];
						cls = rule.cls;
						break;
					}
				}
				if (value === '') {
					value = text[index];
					cls = null;
				}
				pushPlain(tokens, value, cls);
				index += value.length;
				if (tokens.length > HL_TOKEN_LIMIT) return null;
			}
			return tokens;
		}

		function tokenize(text, lang) {
			if (lang === 'md') return tokenizeMarkdown(text);
			return tokenizeCode(text, lang);
		}

		/* Returns the children of a highlighted block, or `null` when the caller
		 * should render the raw string instead (too large, or nothing to colour). */
		function highlightNodes(text, lang) {
			if (typeof text !== 'string' || text === '') return null;
			if (text.length > HL_LIMIT) return null;
			const tokens = tokenize(text, lang);
			if (tokens === null || tokens.length === 0) return null;
			const nodes = [];
			for (let i = 0; i < tokens.length; i += 1) {
				const token = tokens[i];
				if (token.cls === null) nodes.push(token.value);
				else nodes.push(h('span', { key: `t${i}`, className: `fm-tk-${token.cls}` }, token.value));
			}
			return nodes;
		}

		function HighlightedPre({ className, text, lang, onMouseUp }) {
			const nodes = useMemo(() => highlightNodes(text, lang), [text, lang]);
			return h('pre', { className, onMouseUp }, nodes === null ? text : nodes);
		}

		/* The editor is a transparent textarea layered over the highlighted copy;
		 * both share font metrics and padding so the caret lands on the glyph it
		 * belongs to, and the three scroll surfaces stay in lockstep. */
		function CodeEditor({ text, lang, readOnly, onChange, onKeyDown, onContextMenu, textRef }) {
			const hlRef = useRef(null);
			const gutterRef = useRef(null);
			const nodes = useMemo(() => highlightNodes(text, lang), [text, lang]);
			const plain = nodes === null;
			const sync = (element) => {
				const layer = hlRef.current;
				if (layer !== null && layer !== undefined) {
					layer.scrollTop = element.scrollTop;
					layer.scrollLeft = element.scrollLeft;
				}
				const gutter = gutterRef.current;
				if (gutter !== null && gutter !== undefined) gutter.scrollTop = element.scrollTop;
			};
			return h('div', { className: 'fm-editwrap' },
				h('pre', { className: 'fm-gutter', ref: gutterRef, 'aria-hidden': 'true' }, gutterText(text)),
				h('div', { className: 'fm-editbody' },
					plain ? null : h('pre', { className: 'fm-hl', ref: hlRef, 'aria-hidden': 'true' }, nodes),
					h('textarea', {
						ref: textRef,
						className: plain ? 'fm-editor fm-plain' : 'fm-editor',
						value: text,
						spellCheck: false,
						autoCapitalize: 'off',
						autoCorrect: 'off',
						wrap: 'off',
						readOnly,
						onScroll: (event) => sync(event.currentTarget),
						onChange,
						onKeyDown,
						onContextMenu
					})));
		}

		/* Markdown preview through the host's own renderer.
		 *
		 * The renderer owns the whole document: it emits headings, lists, tables,
		 * task lists and highlighted fences with the same chrome the chat uses, so
		 * a README here looks like a README there. Code-fence labels are passed in
		 * because the renderer has no locale seat of its own to borrow — it is a
		 * primitive, not a plugin. `resolveAsset` comes from the panel because only
		 * it knows the workspace root a relative image has to be served from. */
		function MarkdownPreview({ rel, text, labels, resolveAsset, onMouseUp }) {
			const pathImages = useMemo(() => ({
				resolve: (value) => {
					const target = resolveRelativeAsset(rel, value);
					return target === undefined ? undefined : resolveAsset(target);
				}
			}), [rel, resolveAsset]);
			return h('div', { className: 'fm-mdscroll', onMouseUp },
				h('div', { className: 'fm-mdbody', 'data-fm-markdown': rel },
					h(MarkdownText, { text, labels, pathImages, omitHtml: true })));
		}

		/* Rewrite relative `src` / `href` / `poster` values in an HTML document so
		 * they point at the authenticated download route, resolved against the
		 * document's own directory. Absolute URLs, fragments and `data:` URIs are
		 * left untouched; anything that fails to resolve keeps its original value.
		 * Attribute-style rewriting is deliberately shallow — `srcset`, inline
		 * styles and `<style>` blocks are preview niceties, not a rendering
		 * contract, and a full DOM pass needs a parser this plugin does not have. */
		function rewriteHtmlAssets(rel, html, resolveAsset) {
			return String(html).replace(/\s(src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
				(match, attribute, doubleQuoted, singleQuoted) => {
					const value = doubleQuoted !== undefined ? doubleQuoted : singleQuoted;
					const target = resolveRelativeAsset(rel, value);
					if (target === undefined) return match;
					const url = resolveAsset(target);
					if (url === undefined) return match;
					return ` ${String(attribute).toLowerCase()}="${String(url).replace(/"/g, '&quot;')}"`;
				});
		}

		/* HTML preview in a fully sandboxed frame: `sandbox=""` denies scripts,
		 * forms, popups and navigation, so the document renders as static markup
		 * only — the same trust level the PDF frame already gets. `srcdoc` keeps
		 * the content out of any origin, which is why relative references have to
		 * be rewritten above rather than resolved by the browser. */
		function HtmlPreview({ rel, text, resolveAsset }) {
			const srcDoc = useMemo(() => rewriteHtmlAssets(rel, text, resolveAsset), [rel, text, resolveAsset]);
			return h('iframe', { className: 'fm-htmlframe', title: rel, sandbox: '', srcDoc, referrerPolicy: 'no-referrer' });
		}

		/* ------------------------------------------------------------- panel */

		/* A selection elsewhere in the page (chat text, another panel) must not be
		 * offered as "the selected text" of the preview. */
		function previewSelectionText(event) {
			if (typeof window === 'undefined' || !window.getSelection) return '';
			const selection = window.getSelection();
			const text = String(selection || '');
			if (text === '') return '';
			const holder = event && event.currentTarget ? event.currentTarget : null;
			if (!holder || typeof holder.contains !== 'function') return text;
			const anchor = selection.anchorNode;
			if (anchor && holder.contains(anchor.nodeType === 3 ? anchor.parentNode : anchor)) return text;
			return '';
		}

		function FilesPanel(props) {
			const { useTabInfo, sessionId, useSessions, inputActions, t } = props;
			const useInput = props.useInput;
			/* The draft around the caret decides whether an insertion needs a separator
			 * at all; without it we would have to guess and could re-flow the text the
			 * user already typed. */
			/* `useInput` is part of this slot's standardProps, so its presence never
			 * changes between renders and calling it behind this guard keeps hook order
			 * stable; the unreadable-draft branch only protects against a future slot
			 * that stops providing it. */
			const hasDraft = typeof useInput === 'function';
			const draftText = hasDraft
				? useInput((state) => (state && typeof state.draft === 'string' ? state.draft : ''))
				: '';
			const { tab } = useTabInfo();
			const { actions: tabActions } = tab;
			const cwd = useSessions((sessions) => sessions.byId[sessionId] && sessions.byId[sessionId].cwd);

			const [root, setRoot] = useState(cwd);
			const [tree, setTree] = useState({});
			const [selected, setSelected] = useState([]);
			const [anchor, setAnchor] = useState(null);
			const [currentDir, setCurrentDir] = useState('');
			const [clipboard, setClipboard] = useState(null);
			const [menu, setMenu] = useState(null);
			const [shortcuts, setShortcuts] = useState(null);
			const [dialog, setDialog] = useState(null);
			const [editor, setEditor] = useState(null);
			const [preview, setPreview] = useState(null);
			const [toast, setToast] = useState(null);
			const [busy, setBusy] = useState(null);
			const [dragOver, setDragOver] = useState(false);
			const [showHidden, setShowHidden] = useState(false);
			const [query, setQuery] = useState('');
			const [searching, setSearching] = useState(false);
			const [textMenu, setTextMenu] = useState(null);
			/* Markdown and HTML previews open rendered; `rawView` is the per-file
			 * escape hatch back to the highlighted source — what you want when you
			 * are proof-reading syntax rather than reading the document. */
			const [rawView, setRawView] = useState(false);

			/* `MarkdownText` keys its parse cache on the identity of `labels` and
			 * `pathImages`, so rebuilding either on every render would re-parse the
			 * whole document on every keystroke elsewhere in the panel. Both are
			 * therefore memoized on exactly what they depend on. */
			const mdLabels = useMemo(() => ({
				code: {
					copyLabel: t('codeCopy'),
					copiedLabel: t('codeCopied'),
					toolbarLabels: {
						codeLabel: t('codeLabel'),
						wrapLabel: t('codeWrap'),
						unwrapLabel: t('codeUnwrap')
					}
				},
				footnotes: t('footnotesLabel')
			}), [t]);
			const mdResolveAsset = useCallback((target) => downloadUrl(root, target, true), [root]);

			const bodyRef = useRef(null);
			const uploadRef = useRef(null);
			const uploadDirRef = useRef(null);
			const folderRef = useRef(null);
			const downloadRef = useRef(null);
			const openEditorRef = useRef(null);
			const toastTimer = useRef(null);
			const treeRef = useRef(tree);
			const searchRef = useRef(null);
			treeRef.current = tree;
			const textElRef = useRef(null);

			/* Follow the session's workspace only when the session's cwd itself
			 * changes. Reacting to `root` as well would immediately undo a manual
			 * jump through the toolbar menu, snapping the panel back to the
			 * workspace on the very next render. */
			const appliedCwdRef = useRef(cwd);
			useEffect(() => {
				if (cwd === undefined) return;
				if (appliedCwdRef.current === cwd) return;
				appliedCwdRef.current = cwd;
				setRoot(cwd);
			}, [cwd]);

			/* Quick jump targets: the session workspaces plus the usual home/tmp
			 * directories, so the panel is not trapped inside one workspace. */
			useEffect(() => {
				let cancelled = false;
				op('roots', {})
					.then((value) => {
						if (!cancelled) setShortcuts(value && Array.isArray(value.roots) ? value.roots : []);
					})
					.catch(() => {
						if (!cancelled) setShortcuts([]);
					});
				return () => {
					cancelled = true;
				};
			}, []);

			const notify = useCallback((message, kind) => {
				if (toastTimer.current) clearTimeout(toastTimer.current);
				setToast({ message, kind: kind || 'info' });
				toastTimer.current = setTimeout(() => setToast(null), 2800);
			}, []);

			useEffect(() => () => {
				if (toastTimer.current) clearTimeout(toastTimer.current);
			}, []);

			const loadDir = useCallback(async (rel) => {
				if (root === undefined) return;
				setTree((previous) => {
					const current = previous[rel];
					return { ...previous, [rel]: { ...(current || {}), status: 'loading' } };
				});
				try {
					const value = await op('list', { root, rel });
					setTree((previous) => ({
						...previous,
						[rel]: { status: 'ready', entries: value.entries, truncated: value.truncated }
					}));
				} catch (error) {
					setTree((previous) => ({
						...previous,
						[rel]: { status: 'error', error: error.message }
					}));
				}
			}, [root]);

			const reloadAll = useCallback(async () => {
				const rels = new Set(Object.keys(treeRef.current));
				rels.add('');
				rels.add(currentDir);
				await Promise.all([...rels].map((rel) => loadDir(rel)));
			}, [currentDir, loadDir]);

			useEffect(() => {
				if (root === undefined) return;
				setTree({});
				setSelected([]);
				setAnchor(null);
				setCurrentDir('');
				setClipboard(null);
				/* Switching workspaces must not leave overlays or menus pointing at
				 * paths from the previous root. */
				setQuery('');
				setSearching(false);
				setMenu(null);
				setTextMenu(null);
				setDialog(null);
				setEditor(null);
				setPreview(null);
				loadDir('');
			}, [root, loadDir]);

			useEffect(() => {
				if (!preview || editor || dialog) return undefined;
				const onKey = (event) => {
					if (event.key === 'Escape' && !event.defaultPrevented) {
						event.preventDefault();
						setPreview(null);
					}
				};
				window.addEventListener('keydown', onKey);
				return () => window.removeEventListener('keydown', onKey);
			}, [preview, editor, dialog]);

			useEffect(() => {
				if (!tabActions || typeof tabActions.bindCommands !== 'function') return undefined;
				return tabActions.bindCommands({
					refresh: () => {
						reloadAll();
					}
				});
			}, [tabActions, reloadAll]);

			const entryOf = useCallback((rel) => {
				if (rel === '') return { name: baseName(root || ''), type: 'directory' };
				const node = tree[parentRel(rel)];
				if (node && node.entries) {
					const found = node.entries.find((entry) => entry.name === baseName(rel));
					if (found) return found;
				}
				return { name: baseName(rel), type: 'file' };
			}, [tree, root]);

			/* Filtering searches every directory that is already loaded, and keeps the
			 * ancestors of every hit so a match stays in its folder context instead of
			 * appearing as a nameless row. */
			const matched = useMemo(() => {
				const needle = query.trim().toLowerCase();
				if (needle === '') return null;
				const found = new Set();
				const scan = (rel) => {
					const node = tree[rel];
					if (!node || !node.entries) return;
					for (const entry of node.entries) {
						if (!showHidden && entry.name.startsWith('.')) continue;
						const child = joinRel(rel, entry.name);
						if (entry.name.toLowerCase().indexOf(needle) >= 0) {
							found.add(child);
							let parent = parentRel(child);
							while (parent !== '' && !found.has(parent)) {
								found.add(parent);
								parent = parentRel(parent);
							}
						}
						if (entry.type === 'directory') scan(child);
					}
				};
				scan('');
				return found;
			}, [tree, showHidden, query]);

			const rows = useMemo(() => {
				const output = [];
				/* The panel is a folder navigator, not an expandable tree: the list always
				 * shows the children of one directory, so the breadcrumb and the rows can
				 * never disagree. A search is the only time rows come from several
				 * directories at once, and then each row carries its own `depth`. */
				const walk = (rel, depth) => {
					const node = tree[rel];
					if (!node) return;
					if (node.status === 'loading') {
						if (!matched) output.push({ note: 'loading', depth, key: `n-${rel}-l` });
						return;
					}
					if (node.status === 'error') {
						if (!matched) output.push({ note: 'error', message: node.error, depth, key: `n-${rel}-e` });
						return;
					}
					if (node.entries.length === 0 && !matched) {
						output.push({ note: 'empty', depth, key: `n-${rel}-0` });
					}
					for (const entry of node.entries) {
						if (!showHidden && entry.name.startsWith('.')) continue;
						const child = joinRel(rel, entry.name);
						const hit = matched !== null && matched.has(child);
						if (matched && !hit) continue;
						output.push({
							rel: child,
							name: entry.name,
							type: entry.type,
							size: entry.size,
							symlink: entry.symlink,
							depth,
							key: child
						});
						const isDir = entry.type === 'directory';
						if (matched && isDir) walk(child, depth + 1);
					}
				};
				const start = matched ? '' : currentDir;
				/* A just-entered directory has no node yet — the fetch that fills it is
				 * the very next tick, so show the loading note instead of a blank list. */
				if (!matched && !tree[start]) output.push({ note: 'loading', depth: 0, key: `n-${start}-u` });
				else walk(start, 0);
				return output;
			}, [tree, showHidden, matched, currentDir]);

			const visible = useMemo(() => rows.filter((row) => !row.note), [rows]);
			const selectedSet = useMemo(() => new Set(selected), [selected]);
			const cutSet = useMemo(() => new Set(clipboard && clipboard.mode === 'cut' ? clipboard.rels : []), [clipboard]);

			const targetDir = useCallback(() => {
				if (selected.length === 1) {
					const entry = entryOf(selected[0]);
					if (entry.type === 'directory') return selected[0];
				}
				return currentDir;
			}, [selected, entryOf, currentDir]);

			/* Navigating is a deliberate act (double-click, Enter, chevron or a
			 * breadcrumb), never a side effect of merely selecting a row — otherwise
			 * a stray single click would swap the listing under the pointer. */
			/* Switch the whole panel to another root directory. The reset effect
			 * above already discards tree, selection, overlays and menus whenever
			 * `root` changes, so this only has to move the root. */
			const switchRoot = useCallback((nextRoot) => {
				if (typeof nextRoot !== 'string' || nextRoot === '') return;
				setRoot(nextRoot);
			}, []);

			const enterDir = useCallback((rel) => {
				setCurrentDir(rel);
				setSelected([]);
				setAnchor(null);
				const node = treeRef.current[rel];
				if (!node || node.status !== 'ready') loadDir(rel);
			}, [loadDir]);

			const triggerDownload = useCallback((href, filename) => {
				const anchor = downloadRef.current;
				if (!anchor) return;
				anchor.href = href;
				anchor.download = filename || '';
				anchor.click();
			}, []);

			/* ------------------------------------------------------- mutations */

			const askName = useCallback((title, initial, onSubmit) => {
				setDialog({ kind: 'prompt', title, initial, confirmLabel: t('confirm'), onSubmit });
			}, [t]);

			const askConfirm = useCallback((title, message, confirmLabel, danger, onSubmit) => {
				setDialog({ kind: 'confirm', title, message, confirmLabel, danger, onSubmit });
			}, []);

			const newFile = useCallback((dir) => {
				askName(t('newFileTitle'), t('defaultFileName'), async (name) => {
					const rel = joinRel(dir, name);
					try {
						await op('write', { root, rel, content: '' });
						await loadDir(dir);
						setSelected([rel]);
						setCurrentDir(dir);
						if (openEditorRef.current) openEditorRef.current(rel);
					} catch (error) {
						notify(describeError(error, t), 'error');
					}
				});
			}, [askName, t, root, loadDir]);

			const newFolder = useCallback((dir) => {
				askName(t('newFolderTitle'), t('defaultFolderName'), async (name) => {
					try {
						await op('mkdir', { root, rel: joinRel(dir, name) });
						await loadDir(dir);
						notify(t('created', { name }));
					} catch (error) {
						notify(describeError(error, t), 'error');
					}
				});
			}, [askName, t, root, loadDir, notify]);

			const openEditor = useCallback(async (rel) => {
				setPreview(null);
				setEditor({ rel, name: baseName(rel), loading: true, text: '', savedText: '', dirty: false, binary: false, truncated: false, saving: false });
				try {
					const value = await op('read', { root, rel });
					setEditor({
						rel,
						name: baseName(rel),
						loading: false,
						text: value.text || '',
						savedText: value.text || '',
						binary: value.binary,
						truncated: value.truncated,
						size: value.size,
						mtimeMs: value.mtimeMs,
						saving: false
					});
				} catch (error) {
					setEditor(null);
					notify(describeError(error, t), 'error');
				}
			}, [root, notify]);

			openEditorRef.current = openEditor;

			const openPreview = useCallback(async (rel) => {
				setEditor(null);
				setRawView(false);
				const name = baseName(rel);
				const ext = extOf(name);
				const base = { rel, name, ext, loading: true };
				if (IMAGE_EXT.has(ext)) {
					setPreview({ ...base, loading: false, kind: 'image', url: downloadUrl(root, rel, true) });
					return;
				}
				if (ext === 'pdf') {
					setPreview({ ...base, loading: false, kind: 'pdf', url: downloadUrl(root, rel, true) });
					return;
				}
				if (VIDEO_EXT.has(ext)) {
					setPreview({ ...base, loading: false, kind: 'video', url: downloadUrl(root, rel, true) });
					return;
				}
				if (AUDIO_EXT.has(ext)) {
					setPreview({ ...base, loading: false, kind: 'audio', url: downloadUrl(root, rel, true) });
					return;
				}
				if (TEXT_EXT.has(ext) || ext === '') {
					setPreview({ ...base, loading: true, kind: 'text' });
					try {
						const value = await op('read', { root, rel, maxBytes: 512 * 1024 });
						setPreview({
							...base,
							loading: false,
							kind: value.binary ? 'binary' : 'text',
							text: value.text || '',
							truncated: value.truncated,
							size: value.size
						});
					} catch (error) {
						setPreview(null);
						notify(describeError(error, t), 'error');
					}
					return;
				}
				setPreview({ ...base, loading: false, kind: 'binary' });
			}, [root, notify]);

			const saveEditor = useCallback(async (force) => {
				if (!editor || editor.binary || editor.truncated) return;
				const snapshot = editor;
				setEditor((previous) => (previous ? { ...previous, saving: true } : previous));
				try {
					const value = await op('write', {
						root,
						rel: snapshot.rel,
						content: snapshot.text,
						baseMtimeMs: force ? undefined : snapshot.mtimeMs
					});
					setEditor((previous) => (previous && previous.rel === snapshot.rel
						? { ...previous, saving: false, savedText: previous.text, mtimeMs: value.mtimeMs, size: value.size }
						: previous));
					notify(t('saved'));
					loadDir(parentRel(snapshot.rel));
				} catch (error) {
					setEditor((previous) => (previous ? { ...previous, saving: false } : previous));
					if (error.code === 'conflict') {
						askConfirm(t('conflictTitle'), t('conflictMessage'), t('overwrite'), true, () => saveEditor(true));
					} else {
						notify(describeError(error, t), 'error');
					}
				}
			}, [editor, root, notify, t, loadDir, askConfirm]);

			const closeEditor = useCallback(() => {
				if (editor && editor.text !== editor.savedText) {
					askConfirm(t('unsaved'), t('discardChanges'), t('close'), true, () => setEditor(null));
					return;
				}
				setEditor(null);
			}, [editor, askConfirm, t]);

			const doDelete = useCallback((rels) => {
				if (!rels.length) return;
				const hasDir = rels.some((rel) => entryOf(rel).type === 'directory');
				const message = t('deleteMessage', { count: rels.length }) + (hasDir ? `\n${t('deleteDirNote')}` : '');
				askConfirm(t('deleteTitle'), message, t('delete'), true, async () => {
					setBusy(t('deleting'));
					try {
						await op('delete', { root, rels, recursive: true });
						notify(t('deleted', { count: rels.length }));
						setSelected([]);
						await reloadAll();
					} catch (error) {
						notify(describeError(error, t), 'error');
					} finally {
						setBusy(null);
					}
				});
			}, [askConfirm, t, entryOf, root, notify, reloadAll]);

			const doCompress = useCallback(async (rels, format) => {
				if (!rels.length) return;
				setBusy(t('compressing'));
				try {
					const value = await op('compress', { root, rels, format });
					notify(t('compressed', { name: value.name }));
					await reloadAll();
				} catch (error) {
					notify(describeError(error, t), 'error');
				} finally {
					setBusy(null);
				}
			}, [root, notify, t, reloadAll]);

			const doExtract = useCallback(async (rel) => {
				setBusy(t('extracting'));
				try {
					const value = await op('extract', { root, rel });
					notify(t('extracted', { name: baseName(value.rel) }));
					await reloadAll();
				} catch (error) {
					notify(describeError(error, t), 'error');
				} finally {
					setBusy(null);
				}
			}, [root, notify, t, reloadAll]);

			const doPaste = useCallback(async (dir) => {
				if (!clipboard || !clipboard.rels.length) return;
				try {
					const value = clipboard.mode === 'cut'
						? await op('move', { root, rels: clipboard.rels, destRel: dir })
						: await op('copy', { root, rels: clipboard.rels, destRel: dir });
					notify(t('pasted', { count: value.entries.length }));
					if (clipboard.mode === 'cut') setClipboard(null);
					await loadDir(dir);
					await reloadAll();
				} catch (error) {
					notify(describeError(error, t), 'error');
				}
			}, [clipboard, root, notify, t, loadDir, reloadAll]);

			const doDownload = useCallback(async (rels) => {
				if (!rels.length) return;
				try {
					if (rels.length === 1) {
						const entry = entryOf(rels[0]);
						const name = entry.type === 'directory' ? `${baseName(rels[0])}.zip` : baseName(rels[0]);
						const response = await fetch(downloadUrl(root, rels[0], false));
						if (!response.ok) {
							const data = await response.json().catch(() => null);
							throw codeError(data, response.status);
						}
						const blob = await response.blob();
						const url = URL.createObjectURL(blob);
						triggerDownload(url, name);
						setTimeout(() => URL.revokeObjectURL(url), 60000);
						notify(t('downloadStarted'));
						return;
					}
					const response = await fetch(apiUrl('api/fm/zip'), {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ root, rels })
					});
					if (!response.ok) {
						const data = await response.json().catch(() => null);
						throw codeError(data, response.status);
					}
					const blob = await response.blob();
					const url = URL.createObjectURL(blob);
					triggerDownload(url, 'selection.zip');
					setTimeout(() => URL.revokeObjectURL(url), 60000);
					notify(t('downloadStarted'));
				} catch (error) {
					notify(describeError(error, t), 'error');
				}
			}, [entryOf, root, triggerDownload, notify, t]);

			const rename = useCallback((rel) => {
				const entry = entryOf(rel);
				askName(t('renameTitle'), entry.name, async (name) => {
					try {
						await op('rename', { root, rel, name });
						notify(t('renamed'));
						await reloadAll();
					} catch (error) {
						notify(describeError(error, t), 'error');
					}
				});
			}, [entryOf, askName, t, root, notify, reloadAll]);

			const uploadFiles = useCallback(async (files, dir) => {
				const list = [...files];
				if (!list.length) return;
				setBusy(t('working'));
				try {
					let done = 0;
					for (const file of list) {
						const relative = file.webkitRelativePath || file.name;
						const relativeDir = parentRel(relative);
						const targetDir = relativeDir === '' ? dir : joinRel(dir, relativeDir);
						if (relativeDir !== '') {
							try {
								await op('mkdir', { root, rel: targetDir, recursive: true });
							} catch (error) {
								if (error.code !== 'exists') throw error;
							}
						}
						setBusy(`${t('uploading', { name: file.name })} (${done + 1}/${list.length})`);
						const response = await fetch(uploadUrl(root, targetDir, file.name), {
							method: 'POST',
							headers: { 'content-type': 'application/octet-stream' },
							body: file
						});
						const data = await response.json().catch(() => null);
						if (!data || data.ok !== true) {
							throw codeError(data, response.status);
						}
						done += 1;
					}
					notify(t('uploadedMany', { count: done }));
					await loadDir(dir);
				} catch (error) {
					notify(describeError(error, t), 'error');
				} finally {
					setBusy(null);
				}
			}, [root, t, notify, loadDir]);

			/* ------------------------------------------------------------ chat */

			/* The composer renders an `@`-picked file as its own chip node, and the only
			 * sanctioned way to produce one from outside is a whole-draft rewrite: the
			 * draft snapshot carries `{text, references}`, and `setDraft` routes anything
			 * with references through `restoreDraft`, which rebuilds the chips. Reading
			 * the live occurrences lets us keep the ones already in the draft and shift
			 * them across the edit, so nothing the user picked earlier is lost. */
			const draftOccurrences = hasDraft
				? useInput((state) => (state && state.occurrences) || null)
				: null;

			/* Mirror of the chips currently attached to the conversation. Derived from
			 * the draft itself rather than from our own bookkeeping, so manual edits in
			 * the composer stay in sync. */
			const attachedChips = useMemo(() => {
				const list = Array.isArray(draftOccurrences) ? draftOccurrences : [];
				return list.filter((item) => item
					&& typeof item.clipboardText === 'string'
					&& (item.appearance === 'file' || item.appearance === 'folder'));
			}, [draftOccurrences]);

			const pieceOf = useCallback((rel) => {
				const entry = entryOf(rel);
				const isDirectory = entry !== undefined && entry.type === 'directory';
				const mention = mentionOf(rel, isDirectory);
				if (mention === null) return null;
				const name = baseName(rel);
				return {
					mention,
					label: isDirectory ? `${name}/` : name,
					appearance: isDirectory ? 'folder' : 'file'
				};
			}, [entryOf]);

			const attachToComposer = useCallback((parts, options) => {
				const list = (parts || []).filter((part) => part && typeof part.mention === 'string' && part.mention !== '');
				const opts = options || {};
				const suffix = typeof opts.suffix === 'string' ? opts.suffix : '';
				if (list.length === 0 && suffix === '') return;
				if (!inputActions || typeof inputActions.captureInsertion !== 'function') {
					notify(t('noComposer'), 'error');
					return;
				}
				let span;
				try {
					span = inputActions.captureInsertion();
				} catch (error) {
					notify(t('addToChatFailed', { message: describeError(error, t) }), 'error');
					return;
				}
				const detectStart = span && typeof span.start === 'number' ? span.start : null;
				const detectEnd = span && typeof span.end === 'number' ? span.end : detectStart;
				/* The captured span is detect-coordinate; every offset we splice below
				 * belongs to the clipboard projection that the published draft uses. */
				const keep = Array.isArray(draftOccurrences) ? draftOccurrences : [];
				const converted = detectStart === null
					? null
					: { start: detectToClipboard(keep, detectStart), end: detectToClipboard(keep, detectEnd) };
				const start = converted === null ? draftText.length : converted.start;
				const end = converted === null ? start : converted.end;
				const before = draftText.slice(0, start);
				const after = draftText.slice(end);
				/* A bare mention stays inline: it borrows one space only when the caret is
				 * glued to a word, so nothing already typed gets pushed to a new line. A
				 * snippet needs its own line. */
				const block = opts.block === true || suffix !== '';
				let leading = '';
				if (before !== '' && !/\n$/.test(before)) leading = block ? '\n' : (/\s$/.test(before) ? '' : ' ');
				let trailing = '';
				if (after !== '' && !/^\s/.test(after)) trailing = block ? '\n' : ' ';
				const body = list.map((part) => part.mention).join(' ') + suffix;
				/* Plan one splice; the caller re-plans at the document end when the
				 * composer would reject the references, so a bad capture can never
				 * drop the chips that came before it. */
				const plan = (cutStart, cutEnd) => {
					const head = draftText.slice(0, cutStart);
					const tail = draftText.slice(cutEnd);
					let lead = '';
					if (head !== '' && !/\n$/.test(head)) lead = block ? '\n' : (/\s$/.test(head) ? '' : ' ');
					let trail = '';
					if (tail !== '' && !/^\s/.test(tail)) trail = block ? '\n' : ' ';
					const chunk = `${lead}${body}${trail}`;
					const nextText = `${head}${chunk}${tail}`;
					const shift = chunk.length - (cutEnd - cutStart);
					const references = [];
					for (const item of keep) {
						if (!item) continue;
						if (item.offset + item.length <= cutStart) references.push(item);
						else if (item.offset >= cutEnd) references.push(Object.assign({}, item, { offset: item.offset + shift }));
					}
					let cursor = cutStart + lead.length;
					for (const part of list) {
						references.push({
							source: 'reference',
							ref: part.mention,
							label: part.label,
							appearance: part.appearance,
							clipboardText: part.mention,
							offset: cursor,
							length: part.mention.length
						});
						cursor += part.mention.length + 1;
					}
					references.sort((left, right) => left.offset - right.offset);
					return { text: nextText, references };
				};
				let planned = plan(start, end);
				if (!draftIsValid(planned.text, planned.references)) planned = plan(draftText.length, draftText.length);
				const { text, references } = planned;
				try {
					if (typeof inputActions.setDraft === 'function') {
						inputActions.setDraft({ text, references });
					} else if (inputActions.insertText(inserted, span) !== true) {
						notify(t('addToChatFailed', { message: t('composerBusy') }), 'error');
						return;
					}
				} catch (error) {
					notify(t('addToChatFailed', { message: describeError(error, t) }), 'error');
					return;
				}
				notify(t('addedToChat'));
			}, [inputActions, notify, t, draftText, draftOccurrences]);

			const addItemsToChat = useCallback((rels) => {
				const parts = [];
				for (const rel of rels) {
					const part = pieceOf(rel);
					if (part !== null) parts.push(part);
				}
				if (parts.length === 0) {
					notify(t('addToChatFailed', { message: t('invalidName') }), 'error');
					return;
				}
				attachToComposer(parts);
			}, [pieceOf, attachToComposer, notify, t]);

			const addSelectionToChat = useCallback((rel, text) => {
				const body = text.replace(/\s+$/, '');
				if (body === '') return;
				const part = rel ? pieceOf(rel) : null;
				const fenced = `\`\`\`\n${body}\n\`\`\``;
				attachToComposer(part === null ? [] : [part], {
					block: true,
					suffix: part === null ? fenced : `\n\n${fenced}`
				});
			}, [pieceOf, attachToComposer]);

			/* Clicking a chip in the panel detaches that file from the conversation. The
			 * composer itself treats a chip click as "open the file", so removal has to
			 * live here; one adjacent space is swallowed so the remaining text keeps its
			 * shape. */
			const detachOccurrence = useCallback((occurrence) => {
				if (!occurrence || !inputActions || typeof inputActions.setDraft !== 'function') return;
				let from = occurrence.offset;
				let to = occurrence.offset + occurrence.length;
				if (draftText.charAt(to) === ' ') to += 1;
				else if (from > 0 && draftText.charAt(from - 1) === ' ') from -= 1;
				const text = `${draftText.slice(0, from)}${draftText.slice(to)}`;
				const keep = Array.isArray(draftOccurrences) ? draftOccurrences : [];
				const delta = from - to;
				const references = [];
				for (const item of keep) {
					if (!item) continue;
					if (item.offset === occurrence.offset
						&& item.length === occurrence.length
						&& item.clipboardText === occurrence.clipboardText) continue;
					if (item.offset + item.length <= from) references.push(item);
					else if (item.offset >= to) references.push(Object.assign({}, item, { offset: item.offset + delta }));
				}
				try {
					inputActions.setDraft({ text, references });
				} catch (error) {
					notify(t('addToChatFailed', { message: describeError(error, t) }), 'error');
				}
			}, [inputActions, notify, t, draftText, draftOccurrences]);

			/* ------------------------------------------------------- clipboard */

			const readClipboardText = useCallback(async () => {
				const board = typeof navigator === 'undefined' ? null : navigator.clipboard;
				if (board && typeof board.readText === 'function') {
					try {
						const value = await board.readText();
						return typeof value === 'string' ? value : null;
					} catch (error) {
						return null;
					}
				}
				return null;
			}, []);

			const editorSelection = useCallback(() => {
				const element = textElRef.current;
				if (!element) return { start: 0, end: 0, text: '' };
				const start = typeof element.selectionStart === 'number' ? element.selectionStart : 0;
				const end = typeof element.selectionEnd === 'number' ? element.selectionEnd : 0;
				const text = element.value.slice(Math.min(start, end), Math.max(start, end));
				return { start, end, text };
			}, []);

			const replaceEditorRange = useCallback((start, end, insert) => {
				const element = textElRef.current;
				const next = `${editor.text.slice(0, start)}${insert}${editor.text.slice(end)}`;
				setEditor({ ...editor, text: next });
				requestAnimationFrame(() => {
					if (!element) return;
					const caret = start + insert.length;
					element.selectionStart = caret;
					element.selectionEnd = caret;
					element.focus();
				});
			}, [editor]);

			const copyEditorSelection = useCallback(async (range) => {
				const picked = range || editorSelection();
				if (picked.text === '') return;
				if (await copyPlainText(picked.text)) notify(t('copiedText'));
			}, [editorSelection, notify, t]);

			const cutEditorSelection = useCallback(async (range) => {
				const picked = range || editorSelection();
				if (picked.text === '') return;
				if (!await copyPlainText(picked.text)) return;
				replaceEditorRange(picked.start, picked.end, '');
				notify(t('cutText'));
			}, [editorSelection, replaceEditorRange, notify, t]);

			const pasteIntoEditor = useCallback(async (range) => {
				const value = await readClipboardText();
				if (value === null || value === '') {
					notify(t('pasteFailed'), 'error');
					return;
				}
				const picked = range || editorSelection();
				replaceEditorRange(picked.start, picked.end, value);
				notify(t('pastedText'));
			}, [readClipboardText, editorSelection, replaceEditorRange, notify, t]);

			const selectAllEditor = useCallback(() => {
				const element = textElRef.current;
				if (!element) return;
				element.focus();
				element.selectionStart = 0;
				element.selectionEnd = typeof element.value === 'string' ? element.value.length : editor.text.length;
			}, [editor]);

			const copyPreviewSelection = useCallback(async (text) => {
				const picked = typeof text === 'string' ? text : (window.getSelection ? String(window.getSelection()) : '');
				if (picked === '') return;
				if (await copyPlainText(picked)) notify(t('copiedText'));
			}, [notify, t]);

			/* Syntax highlighting splits the preview into one span per token, and the
			 * browser stops its word selection at a text-node boundary. Re-apply the
			 * word (double click) or line (triple click) over the whole rendered text
			 * so the preview selects exactly like a plain textarea. A drag selection
			 * reports detail 1 and is left untouched. */
			const selectWordInPreview = useCallback((event) => {
				if (!event || event.detail < 2) return;
				const holder = event.currentTarget || null;
				if (!holder || typeof window === 'undefined' || !window.getSelection) return;
				const selection = window.getSelection();
				if (!selection || selection.rangeCount === 0) return;
				const range = selection.getRangeAt(0);
				if (!holder.contains(range.startContainer)) return;
				const at = textOffsetOf(holder, range.startContainer, range.startOffset);
				if (at === null) return;
				const full = holder.textContent || '';
				const span = event.detail >= 3 ? expandLineAt(full, at) : expandWordAt(full, at);
				if (span === null || span.end <= span.start) return;
				if (applyTextSelection(holder, span.start, span.end)) event.preventDefault();
			}, []);

			const openTextMenu = useCallback((event, kind) => {
				if (event && typeof event.preventDefault === 'function') event.preventDefault();
				const picked = kind === 'editor' ? editorSelection().text : previewSelectionText(event);
				const hasSel = picked.trim() !== '';
				const rel = kind === 'editor' ? (editor ? editor.rel : '') : (preview ? preview.rel : '');
				const range = kind === 'editor' ? editorSelection() : { start: 0, end: 0 };
				const x = event && event.clientX !== undefined ? event.clientX : 40;
				const y = event && event.clientY !== undefined ? event.clientY : 40;
				setMenu(null);
				setTextMenu({ x, y, kind, rel, hasSel, picked, clip: 'unknown', selStart: range.start, selEnd: range.end });
				const board = typeof navigator === 'undefined' ? null : navigator.clipboard;
				if (board && typeof board.readText === 'function') {
					board.readText()
						.then((value) => {
							setTextMenu((previous) => (previous && previous.kind === kind ? { ...previous, clip: value ? 'yes' : 'no' } : previous));
						})
						.catch(() => {
							/* Unreadable clipboard (permission denied) is not the same as
							 * empty: keep paste offered so a denied read cannot hide it. */
							setTextMenu((previous) => (previous && previous.kind === kind ? { ...previous, clip: 'unknown' } : previous));
						});
				}
			}, [editorSelection, editor, preview]);

			/* ------------------------------------------------------------ menu */

			const menuItems = useMemo(() => {
				if (!menu) return [];
				const items = [];
				if (menu.toolbar) {
					items.push({ label: t('newFile'), icon: I.plus, run: () => newFile(currentDir) });
					items.push({ label: t('newFolder'), icon: I.plus, run: () => newFolder(currentDir) });
					items.push({ separator: true });
					items.push({
						label: t('upload'),
						icon: I.upload,
						run: () => {
							uploadDirRef.current = currentDir;
							if (uploadRef.current) uploadRef.current.click();
						}
					});
					items.push({
						label: t('uploadFolder'),
						icon: I.upload,
						run: () => {
							if (folderRef.current) folderRef.current.click();
						}
					});
					items.push({ separator: true });
					items.push({
						label: showHidden ? t('hideHidden') : t('showHidden'),
						icon: I.folder,
						run: () => setShowHidden((previous) => !previous)
					});
					items.push({ label: t('refresh'), icon: I.refresh, run: () => reloadAll() });
					if (shortcuts && shortcuts.length > 0) {
						items.push({ separator: true });
						items.push({ header: t('jumpTo') });
						for (const entry of shortcuts) {
							items.push({
								label: entry.path === root ? `${entry.label} ✓` : entry.label,
								icon: I.folder,
								title: entry.path,
								run: () => switchRoot(entry.path)
							});
						}
					}
					return items;
				}
				const entry = entryOf(menu.rel);
				const rels = selected.length ? selected : [menu.rel];
				const single = rels.length === 1;
				const isDir = entry.type === 'directory';
				const dest = isDir ? menu.rel : currentDir;
				if (single && isDir) {
					items.push({ label: t('openFolder'), icon: I.chevron, run: () => enterDir(menu.rel) });
				}
				if (single && !isDir) {
					items.push({ label: t('preview'), icon: I.image, run: () => openPreview(menu.rel) });
					items.push({ label: t('edit'), icon: I.edit, kbd: 'Enter', run: () => openEditor(menu.rel) });
					items.push({
						label: t('openInPanel'),
						icon: I.external,
						run: () => tabActions.openResource(fileAddress(sessionId, menu.rel))
					});
					items.push({ separator: true });
				}
				items.push({ label: t('newFile'), icon: I.plus, run: () => newFile(dest) });
				items.push({ label: t('newFolder'), icon: I.plus, run: () => newFolder(dest) });
				items.push({
					label: t('upload'),
					icon: I.upload,
					run: () => {
						uploadDirRef.current = dest;
						if (uploadRef.current) uploadRef.current.click();
					}
				});
				if (clipboard && clipboard.rels.length) {
					const dirName = baseName(dest) || t('root');
					items.push({
						label: t('pasteHere', { name: dirName }),
						icon: I.paste,
						kbd: 'Ctrl+V',
						run: () => doPaste(dest)
					});
				}
				items.push({ separator: true });
				items.push({
					label: rels.length > 1 ? t('addToChatMany', { count: rels.length }) : t('addToChat'),
					icon: I.chat,
					run: () => addItemsToChat(rels)
				});
				items.push({ separator: true });
				items.push({ label: t('copy'), icon: I.copy, kbd: 'Ctrl+C', run: () => {
					setClipboard({ mode: 'copy', rels });
					notify(t('copied', { count: rels.length }));
				} });
				items.push({ label: t('cut'), icon: I.cut, kbd: 'Ctrl+X', run: () => {
					setClipboard({ mode: 'cut', rels });
					notify(t('cutDone', { count: rels.length }));
				} });
				items.push({ separator: true });
				items.push({ label: t('compressZip'), icon: I.archive, run: () => doCompress(rels, 'zip') });
				items.push({ label: t('compressTar'), icon: I.archive, run: () => doCompress(rels, 'tar.gz') });
				if (single && !isDir && ARCHIVE_EXT.has(extOf(entry.name))) {
					items.push({
						label: t('extractHere', { name: entry.name.replace(/\.(zip|tar\.gz|tgz|tar)$/i, '') }),
						icon: I.extract,
						run: () => doExtract(menu.rel)
					});
				}
				items.push({ separator: true });
				items.push({
					label: t('copyPath'),
					icon: I.copy,
					run: () => {
						const text = rels.length > 1 ? rels.join('\n') : rels[0];
						copyPlainText(text).then((done) => notify(done ? t('pathCopied') : t('copyFailed'), done ? 'info' : 'error'));
					}
				});
				items.push({
					label: t('copyAbsPath'),
					icon: I.copy,
					run: () => {
						const text = rels.length > 1 ? rels.map((rel) => absOf(root, rel)).join('\n') : absOf(root, rels[0]);
						copyPlainText(text).then((done) => notify(done ? t('pathCopied') : t('copyFailed'), done ? 'info' : 'error'));
					}
				});
				if (single) {
					items.push({
						label: t('copyName'),
						icon: I.copy,
						run: () => {
							copyPlainText(entry.name).then((done) => notify(done ? t('pathCopied') : t('copyFailed'), done ? 'info' : 'error'));
						}
					});
				}
				items.push({ label: t('download'), icon: I.download, run: () => doDownload(rels) });
				/* Omit rather than grey out: rename is meaningless for a multi-selection. */
				if (single) items.push({ label: t('rename'), icon: I.edit, kbd: 'F2', run: () => rename(menu.rel) });
				items.push({ label: t('delete'), icon: I.trash, kbd: 'Del', danger: true, run: () => doDelete(rels) });
				return items;
			}, [menu, entryOf, selected, currentDir, root, clipboard, showHidden, t, enterDir, openPreview, openEditor, tabActions, sessionId, newFile, newFolder, doPaste, notify, doCompress, doExtract, doDownload, rename, doDelete, reloadAll, addItemsToChat, shortcuts, switchRoot]);

			/* Text context menus ignore unavailable entries entirely rather than
			 * greying them out: no selection means no copy / add-to-chat, and an
			 * unreadable clipboard means no paste. */
			const textMenuItems = useMemo(() => {
				if (!textMenu) return [];
				const items = [];
				const push = (item) => {
					if (items.length && items[items.length - 1].separator) items.pop();
					items.push(item);
				};
				const sep = () => {
					if (items.length && !items[items.length - 1].separator) items.push({ separator: true });
				};
				if (textMenu.hasSel) {
					push({
						label: t('addToChatSelection'),
						icon: I.chat,
						run: () => addSelectionToChat(textMenu.rel, textMenu.picked)
					});
					push({
						label: t('copySelection'),
						icon: I.copy,
						kbd: 'Ctrl+C',
						run: () => {
							if (textMenu.kind === 'editor') copyEditorSelection({ start: textMenu.selStart, end: textMenu.selEnd, text: textMenu.picked });
							else copyPreviewSelection(textMenu.picked);
						}
					});
				}
				if (textMenu.kind === 'preview') {
					sep();
					if (textMenu.rel) {
						push({
							label: t('addFileToChat'),
							icon: I.chat,
							run: () => addItemsToChat([textMenu.rel])
						});
						push({
							label: t('copyAbsPath'),
							icon: I.copy,
							run: () => {
								const text = absOf(root, textMenu.rel);
								copyPlainText(text).then((done) => notify(done ? t('pathCopied') : t('copyFailed'), done ? 'info' : 'error'));
							}
						});
					}
				}
				if (textMenu.kind === 'editor') {
					/* A truncated (read-only) editor offers no mutating entries. */
					const writable = !(editor && (editor.truncated || editor.binary));
					if (writable && textMenu.hasSel) {
						sep();
						push({ label: t('cut'), icon: I.cut, kbd: 'Ctrl+X', run: () => cutEditorSelection({ start: textMenu.selStart, end: textMenu.selEnd, text: textMenu.picked }) });
					}
					if (writable && textMenu.clip !== 'no') {
						if (!textMenu.hasSel) sep();
						push({ label: t('paste'), icon: I.paste, kbd: 'Ctrl+V', run: () => pasteIntoEditor({ start: textMenu.selStart, end: textMenu.selEnd }) });
					}
					sep();
					push({ label: t('selectAll'), icon: I.all, kbd: 'Ctrl+A', run: () => selectAllEditor() });
					if (editor && editor.rel) {
						push({
							label: t('copyAbsPath'),
							icon: I.copy,
							run: () => {
								const text = absOf(root, editor.rel);
								copyPlainText(text).then((done) => notify(done ? t('pathCopied') : t('copyFailed'), done ? 'info' : 'error'));
							}
						});
					}
				}
				while (items.length && items[items.length - 1].separator) items.pop();
				return items;
			}, [textMenu, editor, root, t, addSelectionToChat, addItemsToChat, copyEditorSelection, copyPreviewSelection, cutEditorSelection, pasteIntoEditor, selectAllEditor, notify]);

			/* -------------------------------------------------------- handlers */

			const onRowClick = (event, row) => {
				if (event.shiftKey && anchor) {
					const from = visible.findIndex((item) => item.rel === anchor);
					const to = visible.findIndex((item) => item.rel === row.rel);
					if (from >= 0 && to >= 0) {
						const start = Math.min(from, to);
						const end = Math.max(from, to);
						setSelected(visible.slice(start, end + 1).map((item) => item.rel));
					}
				} else if (event.metaKey || event.ctrlKey) {
					setSelected((previous) => previous.includes(row.rel)
						? previous.filter((rel) => rel !== row.rel)
						: [...previous, row.rel]);
					setAnchor(row.rel);
				} else {
					setSelected([row.rel]);
					setAnchor(row.rel);
				}
				if (bodyRef.current) bodyRef.current.focus({ preventScroll: true });
			};

			const onRowDoubleClick = (event, row) => {
				event.preventDefault();
				if (row.type === 'directory') enterDir(row.rel);
				else openPreview(row.rel);
			};

			const onRowContext = (event, row) => {
				event.preventDefault();
				setTextMenu(null);
				setMenu({ x: event.clientX, y: event.clientY, rel: row.rel });
				if (!selected.includes(row.rel)) {
					setSelected([row.rel]);
					setAnchor(row.rel);
				}
			};

			const onKeyDown = (event) => {
				if (editor || preview || dialog) return;
				const mod = event.metaKey || event.ctrlKey;
				if (mod && event.key.toLowerCase() === 'c' && selected.length) {
					event.preventDefault();
					setClipboard({ mode: 'copy', rels: selected });
					notify(t('copied', { count: selected.length }));
					return;
				}
				if (mod && event.key.toLowerCase() === 'x' && selected.length) {
					event.preventDefault();
					setClipboard({ mode: 'cut', rels: selected });
					notify(t('cutDone', { count: selected.length }));
					return;
				}
				if (mod && event.key.toLowerCase() === 'v') {
					event.preventDefault();
					doPaste(targetDir());
					return;
				}
				if ((event.key === 'Delete' || event.key === 'Backspace') && selected.length) {
					event.preventDefault();
					doDelete(selected);
					return;
				}
				if (event.key === 'F2' && selected.length === 1) {
					event.preventDefault();
					rename(selected[0]);
					return;
				}
				if (event.key === 'Enter' && selected.length === 1) {
					event.preventDefault();
					const entry = entryOf(selected[0]);
					if (entry.type === 'directory') enterDir(selected[0]);
					else openPreview(selected[0]);
					return;
				}
				if (event.key === 'Escape') {
					setMenu(null);
					setSelected([]);
					return;
				}
				if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
					if (visible.length === 0) return;
					event.preventDefault();
					const at = selected.length === 1 ? visible.findIndex((row) => row.rel === selected[0]) : -1;
					let next;
					if (event.key === 'Home') next = 0;
					else if (event.key === 'End') next = visible.length - 1;
					else if (event.key === 'ArrowDown') next = at < 0 ? 0 : Math.min(visible.length - 1, at + 1);
					else next = at < 0 ? visible.length - 1 : Math.max(0, at - 1);
					const row = visible[next];
					if (row) {
						setSelected([row.rel]);
						setAnchor(row.rel);
					}
					return;
				}
				/* Right descends into the selected folder, Left climbs to its parent —
				 * the two moves a file navigator is expected to offer. */
				if (event.key === 'ArrowRight' && selected.length === 1) {
					const entry = entryOf(selected[0]);
					if (entry.type === 'directory') {
						event.preventDefault();
						enterDir(selected[0]);
					}
					return;
				}
				if (event.key === 'ArrowLeft') {
					if (currentDir === '') return;
					event.preventDefault();
					const parent = parentRel(currentDir);
					enterDir(parent);
				}
			};

			if (root === undefined) {
				return h('div', { className: 'fm-root' },
					h('div', { className: 'fm-info' }, h(I.info, {}), h('div', null, t('noWorkspace'))));
			}

			const crumbs = currentDir === '' ? [] : currentDir.split('/');
			const rootName = baseName(root) || t('root');
			const totalItems = visible.length;
			const totalFolders = visible.filter((row) => row.type === 'directory').length;
			const folderTarget = targetDir();

			const overlay = editor ? renderEditor() : preview ? renderPreview() : null;

			function renderEditor() {
				const dirty = editor.text !== editor.savedText;
				const lines = editor.text === '' ? 1 : editor.text.split('\n').length;
				return h('div', { className: 'fm-overlay' },
					h('div', { className: 'fm-ovhead' },
						h('span', { className: 'fm-ovtitle', title: editor.rel }, editor.name),
						dirty ? h('span', { className: 'fm-ovsub' }, t('unsaved')) : null,
						h('button', {
							type: 'button',
							className: 'fm-tool',
							title: t('save'),
							disabled: !dirty || editor.saving || editor.binary || editor.truncated || editor.loading,
							onClick: () => saveEditor(false)
						}, h(I.save, {})),
						h('button', { type: 'button', className: 'fm-tool', title: t('download'), onClick: () => doDownload([editor.rel]) }, h(I.download, {})),
						h('button', { type: 'button', className: 'fm-tool', title: t('close'), onClick: closeEditor }, h(I.close, {}))),
					editor.loading
						? h('div', { className: 'fm-info' }, h('div', { className: 'fm-spinner' }), h('div', null, t('loading')))
						: editor.binary
							? h('div', { className: 'fm-info' }, h(I.info, {}), h('div', null, t('binaryFile')))
							: h(CodeEditor, {
								text: editor.text,
								lang: langOf(editor.rel),
								readOnly: editor.truncated,
								textRef: textElRef,
								onContextMenu: (event) => openTextMenu(event, 'editor'),
								onChange: (event) => setEditor({ ...editor, text: event.target.value }),
								onKeyDown: (event) => {
									if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
										event.preventDefault();
										saveEditor(false);
									} else if (event.key === 'Escape') {
										event.preventDefault();
										closeEditor();
									} else if (event.key === 'Tab') {
										event.preventDefault();
										const element = event.currentTarget;
										const start = element.selectionStart;
										const end = element.selectionEnd;
										const next = `${editor.text.slice(0, start)}  ${editor.text.slice(end)}`;
										setEditor({ ...editor, text: next });
										requestAnimationFrame(() => {
											element.selectionStart = start + 2;
											element.selectionEnd = start + 2;
										});
									}
								}
							}),
					h('div', { className: 'fm-footer' },
						h('span', null, t('linesCount', { count: lines })),
						h('span', null, sizeLabel(editor.size)),
						editor.truncated ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, t('largeFile')) : null,
						h('span', { className: 'fm-flex' }),
						h('span', null, t('saveHint'))));
			}

			function renderPreview() {
				const isMarkdown = preview.kind === 'text' && MARKDOWN_EXT.has(preview.ext);
				const isHtml = preview.kind === 'text' && HTML_EXT.has(preview.ext);
				/* `oversized` keeps the toggle off screen entirely: a button that
				 * exists but cannot be honoured is worse than no button. */
				const oversized = typeof preview.text === 'string' && preview.text.length > RENDER_LIMIT;
				const canRenderMarkdown = isMarkdown && MarkdownText !== null && !oversized;
				const canRenderHtml = isHtml && !oversized;
				/* Both formats open rendered and fall back to one shared source
				 * view; `rawView` only ever means "show me the text itself". */
				const showRendered = (canRenderMarkdown || canRenderHtml) && rawView !== true;
				const body = preview.loading
					? h('div', { className: 'fm-info' }, h('div', { className: 'fm-spinner' }), h('div', null, t('loading')))
					: preview.kind === 'image'
						? h('img', { src: preview.url, alt: preview.name })
						: preview.kind === 'pdf'
							? h('iframe', { src: preview.url, title: preview.name, sandbox: '' })
							: preview.kind === 'video'
								? h('video', { src: preview.url, controls: true, preload: 'metadata' })
								: preview.kind === 'audio'
									? h('audio', { src: preview.url, controls: true, preload: 'metadata' })
									: preview.kind === 'text'
										? preview.text
											? isHtml && showRendered
												? h(HtmlPreview, {
													rel: preview.rel,
													text: preview.text,
													resolveAsset: mdResolveAsset
												})
												: showRendered
													? h(MarkdownPreview, {
														rel: preview.rel,
														text: preview.text,
														labels: mdLabels,
														resolveAsset: mdResolveAsset,
														onMouseUp: selectWordInPreview
													})
													: h('div', { className: 'fm-codescroll' },
														h('pre', { className: 'fm-gutter', 'aria-hidden': 'true' }, gutterText(preview.text)),
														h(HighlightedPre, { className: 'fm-pre', text: preview.text, lang: langOf(preview.rel), onMouseUp: selectWordInPreview }))
											: h('pre', { className: 'fm-pre' }, t('empty'))
										: h('div', { className: 'fm-info' },
											h(I.info, {}),
											h('div', null, preview.kind === 'binary' ? t('binaryFile') : t('previewUnavailable')),
											h('div', null, sizeLabel(preview.size)));
				const canEdit = preview.kind === 'text' && preview.truncated !== true;
				const canExternal = preview.kind !== 'binary' && preview.kind !== 'text';
				const canRender = canRenderMarkdown || canRenderHtml;
				const rendered = rawView !== true;
				const fmtToggle = canRender && preview.text
					? h('button', {
						type: 'button',
						className: `fm-tool${rendered ? ' on' : ''}`,
						title: rendered ? t('mdRaw') : t('mdRendered'),
						'aria-pressed': rendered,
						onClick: () => setRawView(!rawView)
					}, h(I.markdown, {}))
					: null;
				return h('div', { className: 'fm-overlay' },
					h('div', { className: 'fm-ovhead' },
						h('span', { className: 'fm-ovtitle', title: preview.rel }, preview.name),
						fmtToggle,
						canEdit ? h('button', { type: 'button', className: 'fm-tool', title: t('edit'), onClick: () => openEditor(preview.rel) }, h(I.edit, {})) : null,
						canExternal ? h('button', {
							type: 'button',
							className: 'fm-tool',
							title: t('openInPanel'),
							onClick: () => tabActions.openResource(fileAddress(sessionId, preview.rel))
						}, h(I.external, {})) : null,
						h('button', { type: 'button', className: 'fm-tool', title: t('download'), onClick: () => doDownload([preview.rel]) }, h(I.download, {})),
						h('button', { type: 'button', className: 'fm-tool', title: t('close'), onClick: () => setPreview(null) }, h(I.close, {}))),
					h('div', {
						className: 'fm-previewbody',
						onContextMenu: (event) => openTextMenu(event, 'preview')
					}, body),
					h('div', { className: 'fm-footer' },
						h('span', null, sizeLabel(preview.size)),
						h('span', { className: 'fm-flex' }),
						preview.rel ? h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, preview.rel) : null));
			}

			return h('div', { className: 'fm-root', 'data-fm-root': root },
				h('div', { className: 'fm-header' },
					h('div', { className: 'fm-crumbs' },
						h('button', {
							type: 'button',
							className: `fm-crumb${currentDir === '' ? ' current' : ''}`,
							onClick: () => enterDir(''),
							title: root
						}, rootName),
						crumbs.map((part, index) => {
							const rel = crumbs.slice(0, index + 1).join('/');
							return [
								h('span', { className: 'fm-sep', key: `sep-${rel}` }, '/'),
								h('button', {
									type: 'button',
									key: `crumb-${rel}`,
									className: `fm-crumb${index === crumbs.length - 1 ? ' current' : ''}`,
									onClick: () => enterDir(rel)
								}, part)
							];
						})
					),
					h('button', { type: 'button', className: 'fm-tool', title: t('newFile'), onClick: () => newFile(folderTarget) }, h(I.plus, {})),
					/* Paste belongs in the toolbar, not only in the row menu: an empty
					 * directory renders no rows at all, so a row context menu is
					 * unreachable exactly when paste is the only thing worth doing.
					 * The button stays in place and greys out instead of vanishing,
					 * because a toolbar whose buttons move is worse than one that
					 * says "nothing to paste" — same reason native file managers do it. */
					h('button', {
						type: 'button',
						className: 'fm-tool',
						title: t('paste'),
						disabled: !(clipboard && clipboard.rels.length),
						onClick: () => doPaste(folderTarget)
					}, h(I.paste, {})),
					h('button', { type: 'button', className: 'fm-tool', title: t('upload'), onClick: () => {
						uploadDirRef.current = folderTarget;
						if (uploadRef.current) uploadRef.current.click();
					} }, h(I.upload, {})),
					h('button', {
						type: 'button',
						className: `fm-tool${searching ? ' on' : ''}`,
						title: searching ? t('closeSearch') : t('search'),
						onClick: () => {
							if (searching) {
								setQuery('');
								setSearching(false);
							} else {
								setSearching(true);
								requestAnimationFrame(() => {
									if (searchRef.current) searchRef.current.focus();
								});
							}
						}
					}, h(I.search, {})),
					h('button', { type: 'button', className: 'fm-tool', title: t('refresh'), onClick: () => reloadAll() }, h(I.refresh, {})),
					h('button', {
						type: 'button',
						className: 'fm-tool',
						title: t('more'),
						onClick: (event) => {
							const rect = event.currentTarget.getBoundingClientRect();
							setMenu({ x: rect.right - 200, y: rect.bottom + 4, rel: '', toolbar: true });
						}
					}, h(I.more, {}))
				),
				searching
					? h('div', { className: 'fm-searchbar' },
						h(I.search, { size: 13 }),
						h('input', {
							ref: searchRef,
							className: 'fm-search',
							type: 'search',
							value: query,
							placeholder: t('searchPlaceholder'),
							'aria-label': t('search'),
							onChange: (event) => setQuery(event.target.value),
							onKeyDown: (event) => {
								if (event.key === 'Escape') {
									event.preventDefault();
									setQuery('');
									setSearching(false);
								}
							}
						}),
						query !== '' ? h('span', { className: 'fm-searchcount' }, t('itemsCount', { count: visible.length })) : null,
						h('button', {
							type: 'button',
							className: 'fm-tool',
							title: t('closeSearch'),
							onClick: () => {
								setQuery('');
								setSearching(false);
							}
						}, h(I.close, {})))
					: null,
				h('div', {
					ref: bodyRef,
					className: 'fm-body',
					tabIndex: 0,
					role: 'tree',
					'aria-label': rootName,
					onKeyDown,
					onDragOver: (event) => {
						if (event.dataTransfer && [...event.dataTransfer.types].includes('Files')) {
							event.preventDefault();
							event.dataTransfer.dropEffect = 'copy';
							setDragOver(true);
						}
					},
					onDragLeave: (event) => {
						if (event.currentTarget === event.target) setDragOver(false);
					},
					onDrop: (event) => {
						event.preventDefault();
						setDragOver(false);
						if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) {
							const row = event.target.closest ? event.target.closest('[data-fm-path]') : null;
							let dir = folderTarget;
							if (row) {
								const rel = row.getAttribute('data-fm-path');
								const entry = entryOf(rel);
								dir = entry.type === 'directory' ? rel : parentRel(rel);
							}
							uploadFiles(event.dataTransfer.files, dir);
						}
					}
				},
					rows.map((row) => {
						if (row.note) {
							if (row.note === 'loading') return h('div', { className: 'fm-note', key: row.key }, t('loading'));
							if (row.note === 'empty') return h('div', { className: 'fm-note', key: row.key }, t('empty'));
							return h('div', { className: 'fm-note error', key: row.key }, t('loadFailed', { message: row.message }));
						}
						return h(Row, {
							key: row.key,
							row,
							selected: selectedSet.has(row.rel),
							cut: cutSet.has(row.rel),
							dropTarget: false,
							t,
							onClick: (event) => onRowClick(event, row),
							onDoubleClick: (event) => onRowDoubleClick(event, row),
							onContextMenu: (event) => onRowContext(event, row),
							onEnter: () => enterDir(row.rel)
						});
					}),
					matched && visible.length === 0 ? h('div', { className: 'fm-note' }, t('noMatches')) : null,
					tree[''] && tree[''].truncated ? h('div', { className: 'fm-note' }, t('truncated')) : null
				),
				/* The selection bar belongs *below* the list, never above it. Above,
				 * the first click of a double click made it appear and pushed every
				 * row down by its own height, so the second click landed on the row
				 * that had moved into that slot — the open gesture silently missed.
				 * Below the scroll box it only shortens the viewport from the bottom,
				 * and rows keep the screen position they had when they were clicked. */
				selected.length > 0
					? h('div', { className: 'fm-selbar' },
						h('span', { className: 'fm-seltext' }, t('selectedCount', { count: selected.length })),
						h('button', { type: 'button', className: 'fm-tool', title: t('copy'), onClick: () => {
							setClipboard({ mode: 'copy', rels: selected });
							notify(t('copied', { count: selected.length }));
						} }, h(I.copy, {})),
						h('button', { type: 'button', className: 'fm-tool', title: t('cut'), onClick: () => {
							setClipboard({ mode: 'cut', rels: selected });
							notify(t('cutDone', { count: selected.length }));
						} }, h(I.cut, {})),
						h('button', {
							type: 'button',
							className: 'fm-tool',
							title: t('compressZip'),
							onClick: () => doCompress(selected, 'zip')
						}, h(I.archive, {})),
						h('button', { type: 'button', className: 'fm-tool', title: t('addToChat'), onClick: () => addItemsToChat(selected) }, h(I.chat, {})),
						h('button', { type: 'button', className: 'fm-tool', title: t('download'), onClick: () => doDownload(selected) }, h(I.download, {})),
						h('button', { type: 'button', className: 'fm-tool', title: t('delete'), onClick: () => doDelete(selected) }, h(I.trash, {})),
						h('button', { type: 'button', className: 'fm-tool', title: t('clearSelection'), onClick: () => setSelected([]) }, h(I.close, {})))
					: null,
				attachedChips.length > 0 ? h('div', { className: 'fm-chips' },
					h('span', { className: 'fm-chipshead' }, t('attachedTitle')),
					attachedChips.map((item) => h('button', {
						key: `${item.offset}:${item.clipboardText}`,
						type: 'button',
						className: 'fm-chip',
						title: t('detachHint', { name: item.label }),
						onClick: () => detachOccurrence(item)
					},
					item.appearance === 'folder' ? h(I.folder, { size: 12 }) : h(I.file, { size: 12 }),
					h('span', { className: 'fm-chiplabel' }, item.label),
					h('span', { className: 'fm-chipx' }, h(I.close, { size: 10 }))))) : null,
				h('div', { className: 'fm-footer' },
					h('span', null, t('itemsCount', { count: totalItems })),
					h('span', null, t('foldersCount', { count: totalFolders })),
					h('span', { className: 'fm-flex' }),
					clipboard ? h('span', { className: 'fm-clip' }, clipboard.mode === 'cut'
						? t('clipboardCut', { count: clipboard.rels.length })
						: t('clipboardCopy', { count: clipboard.rels.length })) : null
				),
				overlay,
				menu ? h(Menu, { menu, items: menuItems, onClose: () => setMenu(null) }) : null,
				textMenu && textMenuItems.length ? h(Menu, { menu: textMenu, items: textMenuItems, onClose: () => setTextMenu(null) }) : null,
				dialog ? h(Dialog, { key: dialog.title, dialog, onClose: () => setDialog(null), t }) : null,
				busy ? h('div', { className: 'fm-busy' },
					h('div', { className: 'fm-spinner' }),
					h('div', null, busy)) : null,
				dragOver ? h('div', { className: 'fm-drop' }, t('dropHint')) : null,
				toast ? h('div', { className: `fm-toast ${toast.kind}`, role: 'status' }, toast.message) : null,
				h('a', { ref: downloadRef, style: { display: 'none' }, 'aria-hidden': true }, ''),
				h('input', {
					ref: uploadRef,
					type: 'file',
					multiple: true,
					style: { display: 'none' },
					onChange: (event) => {
						const files = event.target.files;
						const dir = uploadDirRef.current === null ? folderTarget : uploadDirRef.current;
						uploadDirRef.current = null;
						if (files && files.length) uploadFiles(files, dir === undefined ? '' : dir);
						event.target.value = '';
					}
				}),
				h('input', {
					ref: folderRef,
					type: 'file',
					multiple: true,
					webkitdirectory: '',
					style: { display: 'none' },
					onChange: (event) => {
						const files = event.target.files;
						if (files && files.length) uploadFiles(files, folderTarget);
						event.target.value = '';
					}
				})
			);
		}

		/* -------------------------------------------------------------- title */

		function FilesTitle({ useTabInfo }) {
			const { tab } = useTabInfo();
			return h('span', { className: 'fm-title' }, h(I.folder, { size: 16 }), h('span', null, tab.title));
		}

		/* --------------------------------------------------------------- apply */

		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'file-manager: dictionaries');
			ctx.effect(() => {
				const tag = document.createElement('style');
				tag.dataset.plugin = 'dsh-file-manager';
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => tag.remove();
			}, 'file-manager: styles');
			ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
				name: 'sidebar.right.pane.tab',
				key: FILES_ID,
				priority: -10,
				locale: NS
			}, FilesPanel)), 'file-manager: files tab body');
			ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
				name: 'sidebar.right.pane.tab.title',
				key: FILES_ID,
				priority: -10
			}, FilesTitle)), 'file-manager: files tab title');
		}

		return {
			inject: ['slots', 'locale'],
			apply
		};
	}
});
