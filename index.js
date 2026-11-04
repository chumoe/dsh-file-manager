/**
 * Host half of the workspace file manager.
 *
 * Four authenticated Fetch routes on the connection service carry every
 * filesystem operation the Sidebar panel performs:
 *
 *   POST /api/fm/op        small JSON operations (list, read, write, mkdir,
 *                          rename, copy, move, delete, compress, extract)
 *   POST /api/fm/upload    one streamed file body into a directory
 *   GET  /api/fm/download  one file, or one directory as a zip
 *   POST /api/fm/zip       several paths as one zip (multi-selection download)
 *
 * Every path is resolved against the caller's workspace root and confined to
 * it, including symlink targets: `ensureRealInside` walks the nearest existing
 * ancestor and re-checks its real path. Archive extraction happens in an
 * in-root temporary directory, and both Info-ZIP and GNU tar strip absolute
 * paths and `..` members, so an archive cannot write outside that directory.
 */
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const name = 'file-manager';

/** The connection service authenticates every route; nothing else is required. */
export const inject = ['connection'];

const OP_PATH = '/api/fm/op';
const UPLOAD_PATH = '/api/fm/upload';
const DOWNLOAD_PATH = '/api/fm/download';
const ZIP_PATH = '/api/fm/zip';

/* DSH normally runs on the operator's own machine, so these are guard rails
 * against accidental freezes (a 300k-entry directory, a 400 MB textarea), not a
 * security boundary. Every one of them is generous on purpose. */
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_LIST_ENTRIES = 20000;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;

class FmError extends Error {
	constructor(code, message, details) {
		super(message);
		this.code = code;
		this.details = details;
	}
}

const json = (status, payload) => new Response(JSON.stringify(payload), {
	status,
	headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

/** Filesystem errors that reach the client as a stable FmError instead of a raw
 *  `ENOENT: no such file or directory, stat '/abs/path'`. The errno message both
 *  leaks the absolute host path and turns a plain "file is gone" into a 500. */
const FILESYSTEM_ERRORS = {
	ENOENT: ['not-found', 404, 'no such file or directory'],
	ENOTDIR: ['not-a-directory', 400, 'a path component is not a directory'],
	EISDIR: ['is-a-directory', 400, 'this is a directory'],
	EEXIST: ['exists', 409, 'an entry with that name already exists'],
	ENOTEMPTY: ['not-empty', 409, 'the directory is not empty'],
	EACCES: ['denied', 403, 'permission denied'],
	EPERM: ['denied', 403, 'operation not permitted'],
	EROFS: ['denied', 403, 'the filesystem is read-only'],
	ENOSPC: ['no-space', 507, 'no space left on the device'],
	EMFILE: ['too-many-files', 503, 'too many open files'],
	ENAMETOOLONG: ['bad-name', 400, 'the name is too long']
};

const errorResponse = (error) => {
	const raw = typeof error === 'object' && error !== null && typeof error.code === 'string'
		? error.code
		: 'io';
	const mapped = FILESYSTEM_ERRORS[raw];
	const code = mapped ? mapped[0] : raw;
	const message = mapped
		? mapped[2]
		: error instanceof Error ? error.message : String(error);
	const status = mapped ? mapped[1]
		: code === 'not-found' ? 404
			: code === 'outside' || code === 'denied' ? 403
				: code === 'exists' || code === 'conflict' || code === 'not-empty' ? 409
					: code === 'bad-request' || code === 'bad-path' || code === 'bad-name'
						|| code === 'not-a-directory' || code === 'is-a-directory' ? 400
						: code === 'no-space' ? 507
							: 500;
	return json(status, { ok: false, error: { code, message } });
};

const textDecoder = new TextDecoder();

/* ------------------------------------------------------------------ paths */

/** Normalize a client-supplied workspace-relative path; reject traversal. */
function normalizeRel(value) {
	if (value === undefined || value === null || value === '') return '';
	if (typeof value !== 'string') throw new FmError('bad-path', 'invalid path');
	const cleaned = value.replace(/\\/g, '/').replace(/^\/+/, '');
	if (cleaned === '' || cleaned === '.') return '';
	for (const part of cleaned.split('/')) {
		if (part === '' || part === '.' || part === '..') throw new FmError('bad-path', 'invalid path');
	}
	return cleaned;
}

function isInside(root, target) {
	/* A root of `/` would otherwise make the prefix `'//'` and match nothing,
	 * silently breaking every relative operation below the filesystem root. */
	if (target === root) return true;
	const prefix = root.endsWith(sep) ? root : root + sep;
	return target.startsWith(prefix);
}

/** Resolve one existing-or-new target and prove it cannot escape the root. */
async function resolveInside(root, rel) {
	const abs = resolve(root, rel === '' ? '.' : rel);
	if (!isInside(root, abs)) throw new FmError('outside', 'target is outside the workspace');
	await ensureRealInside(root, abs);
	return abs;
}

/**
 * Walk the nearest existing ancestor of `abs` and verify its real path stays
 * inside `root`. A missing leaf (new file) is fine; a symlinked parent that
 * points outside is not.
 */
async function ensureRealInside(root, abs) {
	let current = abs;
	for (;;) {
		try {
			const real = await fsp.realpath(current);
			if (!isInside(root, real)) throw new FmError('outside', 'target resolves outside the workspace through a symlink');
			return;
		} catch (error) {
			if (error instanceof FmError) throw error;
			if (error && error.code === 'ENOENT') {
				const parent = dirname(current);
				if (parent === current) throw new FmError('outside', 'cannot resolve the target path');
				current = parent;
				continue;
			}
			throw error;
		}
	}
}

/**
 * Every directory this plugin is allowed to expose: the canonical path of each
 * registered workspace, plus the recorded cwd of every live Session. The
 * registry is the durable authority — it survives restarts and covers sessions
 * whose tab is opened from history — while the Session list covers a directory
 * a Session was started in that no workspace owns.
 */
function allowedRoots(ctx) {
	const roots = new Set();
	const registry = ctx.get('workspaceRegistry');
	if (registry !== undefined) {
		try {
			for (const workspace of registry.list()) {
				if (typeof workspace.path === 'string' && isAbsolute(workspace.path)) roots.add(workspace.path);
			}
		} catch {
			/* A misbehaving registry must not widen the allowlist. */
		}
	}
	const sessions = ctx.get('sessions');
	if (sessions !== undefined) {
		try {
			for (const session of sessions.list()) {
				const cwd = session?.header?.cwd;
				if (typeof cwd === 'string' && isAbsolute(cwd)) roots.add(cwd);
			}
		} catch {
			/* Same: no cwd means no extra root. */
		}
	}
	return [...roots];
}

/**
 * Open one directory as this request's root; the real path is the authority.
 *
 * DSH runs on the operator's own machine and the routes already inherit the
 * Host's login/Host/Origin checks, so this is deliberately permissive: any
 * existing absolute directory may be browsed, which is what makes the panel
 * useful for reaching a checkout, a download directory or a log folder outside
 * the session workspace. Confinement still applies *inside* the chosen root —
 * `normalizeRel` rejects `..` and `ensureRealInside` rejects symlink escapes —
 * so relative operations can never reach past what the user is looking at.
 */
async function openRoot(ctx, raw) {
	/* `~` is such a common way to name a home directory that resolving it here
	 * is cheaper than making every caller expand it. */
	let value = raw;
	if (typeof value === 'string' && (value === '~' || value.startsWith('~/'))) {
		const home = process.env.HOME;
		if (typeof home === 'string' && home !== '') value = home + value.slice(1);
	}
	if (typeof value !== 'string' || !isAbsolute(value)) throw new FmError('bad-request', 'invalid workspace path');
	let real;
	try {
		real = await fsp.realpath(value);
	} catch {
		throw new FmError('not-found', 'workspace directory does not exist');
	}
	const stat = await fsp.stat(real);
	if (!stat.isDirectory()) throw new FmError('bad-request', 'workspace path is not a directory');
	return real;
}

const joinRel = (dir, entry) => (dir === '' ? entry : `${dir}/${entry}`);

function safeName(value) {
	if (typeof value !== 'string') throw new FmError('bad-name', 'invalid file name');
	const trimmed = value.trim();
	if (trimmed === '' || trimmed === '.' || trimmed === '..' || /[/\\\0]/.test(trimmed)) {
		throw new FmError('bad-name', 'invalid file name');
	}
	return trimmed;
}

async function exists(abs) {
	try {
		await fsp.lstat(abs);
		return true;
	} catch (error) {
		if (error && error.code === 'ENOENT') return false;
		throw error;
	}
}

async function entryKind(abs) {
	const stat = await fsp.lstat(abs);
	if (stat.isSymbolicLink()) {
		try {
			const target = await fsp.stat(abs);
			return target.isDirectory() ? 'directory' : target.isFile() ? 'file' : 'other';
		} catch {
			return 'other';
		}
	}
	return stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
}

async function uniqueName(dirAbs, name, isDirectory) {
	const ext = isDirectory ? '' : extname(name);
	const stem = ext === '' ? name : name.slice(0, name.length - ext.length);
	let candidate = name;
	let index = 1;
	while (await exists(join(dirAbs, candidate))) {
		index += 1;
		candidate = `${stem} (${index})${ext}`;
	}
	return candidate;
}

/* ------------------------------------------------------------------- ops */

async function readEntireOrHead(abs, size, limit) {
	if (size <= limit) return fsp.readFile(abs);
	const handle = await fsp.open(abs, 'r');
	try {
		const buffer = Buffer.allocUnsafe(limit);
		const { bytesRead } = await handle.read(buffer, 0, limit, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

async function opList(ctx, payload) {
	const root = await openRoot(ctx, payload.root);
	const rel = normalizeRel(payload.rel);
	const abs = await resolveInside(root, rel);
	const dirents = await fsp.readdir(abs, { withFileTypes: true });
	/* Directories first, then a case-insensitive natural order — readdir order is
	 * filesystem-specific and looks random in a tree view. Sorting before the cap
	 * keeps the truncated prefix deterministic too. */
	const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
	dirents.sort((left, right) => {
		const leftDir = left.isDirectory();
		const rightDir = right.isDirectory();
		if (leftDir !== rightDir) return leftDir ? -1 : 1;
		return collator.compare(left.name, right.name);
	});
	const kept = dirents.slice(0, MAX_LIST_ENTRIES);
	const entries = await Promise.all(kept.map(async (dirent) => {
		const entry = { name: dirent.name, type: 'other' };
		if (dirent.isSymbolicLink()) {
			entry.symlink = true;
			try {
				const target = await fsp.stat(join(abs, dirent.name));
				entry.type = target.isDirectory() ? 'directory' : target.isFile() ? 'file' : 'other';
				if (target.isFile()) entry.size = target.size;
			} catch {
				entry.type = 'other';
			}
			return entry;
		}
		if (dirent.isDirectory()) {
			entry.type = 'directory';
			return entry;
		}
		if (dirent.isFile()) {
			entry.type = 'file';
			try {
				entry.size = (await fsp.stat(join(abs, dirent.name))).size;
			} catch {
				entry.size = undefined;
			}
			return entry;
		}
		return entry;
	}));
	return { rel, entries, truncated: dirents.length > MAX_LIST_ENTRIES };
}

async function opRead(ctx, payload) {
	const root = await openRoot(ctx, payload.root);
	const rel = normalizeRel(payload.rel);
	const abs = await resolveInside(root, rel);
	const stat = await fsp.stat(abs);
	if (!stat.isFile()) throw new FmError('not-a-file', 'target is not a file');
	const limit = Math.max(1, Math.min(Number(payload.maxBytes) || MAX_TEXT_BYTES, MAX_TEXT_BYTES));
	const buffer = await readEntireOrHead(abs, stat.size, limit);
	const binary = buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
	return {
		rel,
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		binary,
		truncated: stat.size > limit,
		text: binary ? null : buffer.toString('utf8')
	};
}

async function opWrite(ctx, payload) {
	const root = await openRoot(ctx, payload.root);
	const rel = normalizeRel(payload.rel);
	if (rel === '') throw new FmError('bad-name', 'invalid file name');
	if (typeof payload.content !== 'string') throw new FmError('bad-request', 'invalid content');
	const abs = await resolveInside(root, rel);
	const parent = dirname(abs);
	const parentStat = await fsp.stat(parent).catch(() => undefined);
	if (parentStat === undefined || !parentStat.isDirectory()) throw new FmError('not-found', 'parent directory does not exist');
	const present = await exists(abs);
	if (present) {
		const stat = await fsp.lstat(abs);
		if (stat.isDirectory()) throw new FmError('is-a-directory', 'target is a directory and cannot be written as a file');
		if (payload.baseMtimeMs !== undefined && payload.baseMtimeMs !== null
			&& Math.abs(stat.mtimeMs - Number(payload.baseMtimeMs)) > 1) {
			throw new FmError('conflict', 'file was modified outside the editor', { mtimeMs: stat.mtimeMs, size: stat.size });
		}
	}
	const temp = join(parent, `.${basename(abs)}.fm-${randomUUID()}.tmp`);
	await fsp.writeFile(temp, payload.content, 'utf8');
	try {
		await fsp.rename(temp, abs);
	} catch (error) {
		await fsp.rm(temp, { force: true }).catch(() => undefined);
		throw error;
	}
	const stat = await fsp.stat(abs);
	return { rel, size: stat.size, mtimeMs: stat.mtimeMs };
}

async function opMkdir(ctx, payload) {
	const root = await openRoot(ctx, payload.root);
	const rel = normalizeRel(payload.rel);
	if (rel === '') throw new FmError('bad-name', 'invalid directory name');
	const abs = await resolveInside(root, rel);
	if (await exists(abs)) throw new FmError('exists', 'an entry with that name already exists');
	await fsp.mkdir(abs, { recursive: payload.recursive === true });
	const stat = await fsp.stat(abs);
	return { rel, mtimeMs: stat.mtimeMs };
}

async function opRename(ctx, payload) {
	const root = await openRoot(ctx, payload.root);
	const rel = normalizeRel(payload.rel);
	if (rel === '') throw new FmError('bad-path', 'cannot rename the workspace root');
	const name = safeName(payload.name);
	const abs = await resolveInside(root, rel);
	const target = join(dirname(abs), name);
	if (target === abs) return { rel };
	if (!isInside(root, target)) throw new FmError('outside', 'target is outside the workspace');
	if (await exists(target)) throw new FmError('exists', 'an entry with that name already exists');
	await fsp.rename(abs, target);
	return { rel: joinRel(dirname(rel) === '.' ? '' : dirname(rel), name) };
}

async function opCopy(ctx, payload) {
	return transfer(ctx, payload, 'copy');
}

async function opMove(ctx, payload) {
	return transfer(ctx, payload, 'move');
}

async function transfer(ctx, payload, mode) {
	const root = await openRoot(ctx, payload.root);
	const rels = Array.isArray(payload.rels) ? payload.rels.map(normalizeRel) : [];
	if (rels.length === 0) throw new FmError('bad-request', 'nothing was selected');
	const destRel = normalizeRel(payload.destRel);
	const destAbs = await resolveInside(root, destRel);
	const destStat = await fsp.stat(destAbs).catch(() => undefined);
	if (destStat === undefined || !destStat.isDirectory()) throw new FmError('not-found', 'destination directory does not exist');
	const moved = [];
	for (const rel of rels) {
		if (rel === '') throw new FmError('bad-path', 'cannot move or copy the workspace root');
		const abs = await resolveInside(root, rel);
		const stat = await fsp.lstat(abs);
		if (stat.isDirectory()) {
			if (destAbs === abs || destAbs.startsWith(abs + sep)) {
				throw new FmError('bad-path', 'cannot move or copy a directory into itself');
			}
		}
		const name = await uniqueName(destAbs, basename(abs), stat.isDirectory());
		const next = join(destAbs, name);
		if (mode === 'copy') {
			await fsp.cp(abs, next, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
		} else {
			try {
				await fsp.rename(abs, next);
			} catch (error) {
				if (error && error.code === 'EXDEV') {
					await fsp.cp(abs, next, { recursive: true, errorOnExist: true, force: false });
					await fsp.rm(abs, { recursive: true, force: true });
				} else {
					throw error;
				}
			}
		}
		moved.push({ from: rel, rel: joinRel(destRel, name), name });
	}
	return { entries: moved };
}

async function opDelete(ctx, payload) {
	const root = await openRoot(ctx, payload.root);
	const rels = Array.isArray(payload.rels) ? payload.rels.map(normalizeRel) : [];
	if (rels.length === 0) throw new FmError('bad-request', 'nothing was selected');
	const removed = [];
	for (const rel of rels) {
		if (rel === '') throw new FmError('bad-path', 'cannot delete the workspace root');
		const abs = await resolveInside(root, rel);
		const stat = await fsp.lstat(abs).catch(() => undefined);
		if (stat === undefined) continue;
		if (stat.isDirectory() && payload.recursive !== true) {
			throw new FmError('is-a-directory', 'a directory must be confirmed before it is deleted');
		}
		await fsp.rm(abs, { recursive: stat.isDirectory(), force: false });
		removed.push(rel);
	}
	return { removed };
}

function run(command, args, options) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(command, args, { ...options, stdio: ['ignore', 'ignore', 'pipe'] });
		let stderr = '';
		child.stderr.on('data', (chunk) => {
			stderr += chunk;
			if (stderr.length > 16000) stderr = stderr.slice(-16000);
		});
		child.on('error', rejectPromise);
		child.on('close', (code) => {
			if (code === 0) resolvePromise();
			else rejectPromise(new FmError('archive-failed', stderr.trim() || `${command} exited with code ${code}`));
		});
	});
}

function archiveKind(name) {
	const lower = name.toLowerCase();
	if (lower.endsWith('.zip')) return 'zip';
	if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
	if (lower.endsWith('.tar')) return 'tar';
	return undefined;
}

function archiveStem(name) {
	return name.replace(/\.(zip|tar\.gz|tgz|tar)$/i, '');
}

async function opCompress(ctx, payload) {
	const root = await openRoot(ctx, payload.root);
	const rels = Array.isArray(payload.rels) ? payload.rels.map(normalizeRel) : [];
	if (rels.length === 0) throw new FmError('bad-request', 'nothing was selected');
	const format = payload.format === 'tar.gz' ? 'tar.gz' : 'zip';
	const parents = new Set(rels.map((rel) => (dirname(rel) === '.' ? '' : dirname(rel))));
	const parentRel = payload.destRel !== undefined
		? normalizeRel(payload.destRel)
		: (parents.size === 1 ? [...parents][0] : '');
	const parentAbs = await resolveInside(root, parentRel);
	const parentStat = await fsp.stat(parentAbs).catch(() => undefined);
	if (parentStat === undefined || !parentStat.isDirectory()) throw new FmError('not-found', 'destination directory does not exist');
	const names = rels.map((rel) => {
		if (parentRel === '') return rel;
		if (rel === parentRel) throw new FmError('bad-path', 'cannot compress a directory into itself');
		if (rel.startsWith(parentRel + '/')) return rel.slice(parentRel.length + 1);
		throw new FmError('bad-path', 'the selection is not inside the destination directory');
	});
	const defaultName = (rels.length === 1 ? archiveStem(basename(rels[0])) : 'archive') + (format === 'zip' ? '.zip' : '.tar.gz');
	const name = payload.name === undefined ? defaultName : safeName(payload.name);
	const outputRel = joinRel(parentRel, name);
	const outputAbs = join(parentAbs, name);
	if (await exists(outputAbs)) throw new FmError('exists', 'an archive with that name already exists');
	if (format === 'zip') {
		await run('zip', ['-r', '-q', outputAbs, ...names], { cwd: parentAbs });
	} else {
		await run('tar', ['-czf', outputAbs, ...names], { cwd: parentAbs });
	}
	return { rel: outputRel, name, format };
}

async function opExtract(ctx, payload) {
	const root = await openRoot(ctx, payload.root);
	const rel = normalizeRel(payload.rel);
	if (rel === '') throw new FmError('bad-path', 'select an archive first');
	const abs = await resolveInside(root, rel);
	const stat = await fsp.stat(abs);
	if (!stat.isFile()) throw new FmError('not-a-file', 'target is not a file');
	const kind = archiveKind(basename(abs));
	if (kind === undefined) throw new FmError('bad-request', 'unsupported archive format');
	const parentRel = dirname(rel) === '.' ? '' : dirname(rel);
	const stem = archiveStem(basename(abs));
	const requested = normalizeRel(payload.destRel);
	const baseDestRel = requested === '' ? joinRel(parentRel, stem) : requested;
	const baseDestAbs = await resolveInside(root, baseDestRel);
	const finalName = await uniqueName(dirname(baseDestAbs), basename(baseDestAbs), true);
	const destAbs = join(dirname(baseDestAbs), finalName);
	const destRel = joinRel(dirname(baseDestRel) === '.' ? '' : dirname(baseDestRel), finalName);
	await fsp.mkdir(destAbs, { recursive: true });
	const temp = await fsp.mkdtemp(join(root, '.fm-extract-'));
	try {
		if (kind === 'zip') {
			await run('unzip', ['-qq', '-o', abs, '-d', temp], {});
		} else {
			await run('tar', ['-xf', abs, '-C', temp], {});
		}
		for (const entry of await fsp.readdir(temp)) {
			await fsp.rename(join(temp, entry), join(destAbs, entry));
		}
	} finally {
		await fsp.rm(temp, { recursive: true, force: true }).catch(() => undefined);
	}
	return { rel: destRel, kind };
}

/**
 * Shortcut directories for the sidebar: the session workspaces themselves first,
 * then the places people actually reach for (`~`, Desktop, Downloads, `/tmp`),
 * each only when it exists. The panel shows these as jump targets.
 */
async function opRoots(ctx) {
	const seen = new Set();
	const list = [];
	const push = async (rawPath, label) => {
		if (typeof rawPath !== 'string' || !isAbsolute(rawPath)) return;
		let real;
		try {
			real = await fsp.realpath(rawPath);
			if (!(await fsp.stat(real)).isDirectory()) return;
		} catch {
			return;
		}
		if (seen.has(real)) return;
		seen.add(real);
		list.push({ path: real, label });
	};

	for (const workspacePath of allowedRoots(ctx)) {
		const base = basename(workspacePath);
		await push(workspacePath, base === '' ? workspacePath : base);
	}

	/* Both the DSH process HOME (often the workspace itself) and the account's
	 * real home from passwd, because a NAS commonly overrides HOME. */
	const homes = new Set();
	if (typeof process.env.HOME === 'string' && process.env.HOME !== '') homes.add(process.env.HOME);
	try {
		const { homedir } = await import('node:os');
		const real = homedir();
		if (typeof real === 'string' && real !== '') homes.add(real);
	} catch {
		/* No home is not an error; the common roots below still work. */
	}
	for (const home of homes) {
		await push(home, home === process.env.HOME ? 'Home' : 'User home');
		for (const [name, label] of [['Desktop', 'Desktop'], ['Downloads', 'Downloads'], ['Documents', 'Documents']]) {
			await push(join(home, name), label);
		}
	}

	/* Volumes people actually reach for on this class of host. None of these is
	 * required; a missing directory is simply skipped. */
	for (const [dir, label] of [
		['/tmp', '/tmp'],
		['/vol1', '/vol1'],
		['/vol2', '/vol2'],
		['/vol1/@appshare', '@appshare'],
		['/vol1/@appdata', '@appdata'],
		['/home', '/home'],
		['/root', '/root'],
		['/', '/']
	]) {
		await push(dir, label);
	}
	return { roots: list };
}

async function dispatch(ctx, payload) {
	switch (payload.op) {
		case 'list': return opList(ctx, payload);
		case 'read': return opRead(ctx, payload);
		case 'write': return opWrite(ctx, payload);
		case 'mkdir': return opMkdir(ctx, payload);
		case 'rename': return opRename(ctx, payload);
		case 'copy': return opCopy(ctx, payload);
		case 'move': return opMove(ctx, payload);
		case 'delete': return opDelete(ctx, payload);
		case 'compress': return opCompress(ctx, payload);
		case 'extract': return opExtract(ctx, payload);
		case 'roots': return opRoots(ctx);
		default: throw new FmError('bad-request', `unknown operation: ${String(payload.op)}`);
	}
}

async function handleOp(ctx, request) {
	try {
		const buffer = Buffer.from(await request.arrayBuffer());
		if (buffer.length > MAX_JSON_BYTES) throw new FmError('bad-request', 'request too large');
		let payload;
		try {
			payload = JSON.parse(textDecoder.decode(buffer));
		} catch {
			throw new FmError('bad-request', 'malformed request');
		}
		if (payload === null || typeof payload !== 'object') throw new FmError('bad-request', 'malformed request');
		return json(200, { ok: true, value: await dispatch(ctx, payload) });
	} catch (error) {
		return errorResponse(error);
	}
}

/* -------------------------------------------------------------- downloads */

const MIME = {
	png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
	avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
	pdf: 'application/pdf',
	mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
	mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
	txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8',
	csv: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8', yaml: 'text/plain; charset=utf-8',
	yml: 'text/plain; charset=utf-8', toml: 'text/plain; charset=utf-8', xml: 'text/plain; charset=utf-8'
};

const INLINE_OK = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg', 'pdf', 'mp4', 'webm', 'mov', 'm4v', 'mp3', 'wav', 'ogg', 'm4a', 'flac']);

function mimeOf(name) {
	return MIME[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

function disposition(name, inline) {
	const encoded = encodeURIComponent(name);
	const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
	return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function fileResponse(abs, name, size, inline) {
	const stream = createReadStream(abs);
	return new Response(Readable.toWeb(stream), {
		headers: {
			'content-type': mimeOf(name),
			'content-length': String(size),
			'content-disposition': disposition(name, inline),
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff',
			...(inline && !/\.pdf$/i.test(name) ? { 'content-security-policy': 'sandbox' } : {})
		}
	});
}

async function handleDownload(ctx, request) {
	try {
		const url = new URL(request.url);
		const root = await openRoot(ctx, url.searchParams.get('root'));
		const rel = normalizeRel(url.searchParams.get('rel'));
		const inline = url.searchParams.get('inline') === '1';
		const abs = await resolveInside(root, rel);
		const stat = await fsp.stat(abs);
		if (stat.isFile()) return fileResponse(abs, basename(abs), stat.size, inline && INLINE_OK.has(extname(abs).slice(1).toLowerCase()));
		if (!stat.isDirectory()) throw new FmError('bad-request', 'this entry type cannot be downloaded');
		/* A real path never ends in a separator, so `basename` is never empty:
		 * the case worth refusing is asking to archive the root itself. */
		if (abs === root) throw new FmError('bad-path', 'cannot archive the workspace root');
		const name = `${basename(abs)}.zip`;
		const tempDir = await fsp.mkdtemp(join(tmpdir(), 'fm-dl-'));
		const output = join(tempDir, 'bundle.zip');
		await run('zip', ['-r', '-q', output, basename(abs)], { cwd: dirname(abs) });
		const stream = createReadStream(output);
		const cleanup = () => fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		stream.on('close', cleanup);
		stream.on('error', cleanup);
		const size = (await fsp.stat(output)).size;
		return new Response(Readable.toWeb(stream), {
			headers: {
				'content-type': 'application/zip',
				'content-length': String(size),
				'content-disposition': disposition(name, false),
				'cache-control': 'no-store',
				'x-content-type-options': 'nosniff'
			}
		});
	} catch (error) {
		return errorResponse(error);
	}
}

async function handleZip(ctx, request) {
	try {
		const payload = JSON.parse(textDecoder.decode(Buffer.from(await request.arrayBuffer())));
		const root = await openRoot(ctx, payload.root);
		const rels = (Array.isArray(payload.rels) ? payload.rels : []).map(normalizeRel);
		if (rels.length === 0) throw new FmError('bad-request', 'nothing was selected');
		const name = rels.length === 1 ? `${archiveStem(basename(rels[0]))}.zip` : 'selection.zip';
		const tempDir = await fsp.mkdtemp(join(tmpdir(), 'fm-sel-'));
		const output = join(tempDir, 'bundle.zip');
		if (rels.length === 1) {
			const abs = await resolveInside(root, rels[0]);
			if ((await fsp.stat(abs)).isDirectory()) {
				await run('zip', ['-r', '-q', output, basename(abs)], { cwd: dirname(abs) });
			} else {
				await run('zip', ['-q', output, basename(abs)], { cwd: dirname(abs) });
			}
		} else {
			/* `zip` names entries after the argument, so two selections that share a
			 * basename in different directories would overwrite each other. Stage
			 * them under unique names first, then archive the staging directory. */
			const stage = join(tempDir, 'stage');
			await fsp.mkdir(stage, { recursive: true });
			const used = new Set();
			for (const rel of rels) {
				const abs = await resolveInside(root, rel);
				let entry = basename(abs);
				if (used.has(entry)) {
					const ext = extname(entry);
					const stem = ext === '' ? entry : entry.slice(0, entry.length - ext.length);
					let index = 1;
					while (used.has(`${stem} (${index})${ext}`)) index += 1;
					entry = `${stem} (${index})${ext}`;
				}
				used.add(entry);
				await fsp.cp(abs, join(stage, entry), { recursive: true, force: true, errorOnExist: false });
			}
			await run('zip', ['-r', '-q', output, '.'], { cwd: stage });
		}
		const stream = createReadStream(output);
		const cleanup = () => fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		stream.on('close', cleanup);
		stream.on('error', cleanup);
		const size = (await fsp.stat(output)).size;
		return new Response(Readable.toWeb(stream), {
			headers: {
				'content-type': 'application/zip',
				'content-length': String(size),
				'content-disposition': disposition(name, false),
				'cache-control': 'no-store'
			}
		});
	} catch (error) {
		return errorResponse(error);
	}
}

/* ---------------------------------------------------------------- uploads */

async function handleUpload(ctx, request) {
	const url = new URL(request.url);
	let tempPath;
	try {
		const root = await openRoot(ctx, url.searchParams.get('root'));
		const dirRel = normalizeRel(url.searchParams.get('dir'));
		const rawName = url.searchParams.get('name');
		if (rawName === null) throw new FmError('bad-name', 'missing file name');
		const name = safeName(rawName);
		const dirAbs = await resolveInside(root, dirRel);
		const dirStat = await fsp.stat(dirAbs);
		if (!dirStat.isDirectory()) throw new FmError('not-directory', 'target is not a directory');
		const finalName = await uniqueName(dirAbs, name, false);
		tempPath = join(dirAbs, `.${finalName}.fm-${randomUUID()}.part`);
		const declared = Number(request.headers.get('content-length') ?? 0);
		if (declared > MAX_UPLOAD_BYTES) throw new FmError('bad-request', 'file too large');
		if (request.body === null) throw new FmError('bad-request', 'missing file content');
		await fsp.writeFile(tempPath, Readable.fromWeb(request.body));
		const stat = await fsp.stat(tempPath);
		if (stat.size > MAX_UPLOAD_BYTES) throw new FmError('bad-request', 'file too large');
		const target = join(dirAbs, finalName);
		await fsp.rename(tempPath, target);
		tempPath = undefined;
		return json(200, {
			ok: true,
			value: { rel: joinRel(dirRel, finalName), name: finalName, size: stat.size }
		});
	} catch (error) {
		if (tempPath !== undefined) await fsp.rm(tempPath, { force: true }).catch(() => undefined);
		return errorResponse(error);
	}
}

/* --------------------------------------------------------------- lifecycle */

export function apply(ctx) {
	ctx.effect(() => ctx.connection.fetch.register({
		path: OP_PATH,
		methods: ['POST'],
		requestBody: 'buffered',
		fetch: (request) => handleOp(ctx, request)
	}), 'file-manager: operations route');
	ctx.effect(() => ctx.connection.fetch.register({
		path: UPLOAD_PATH,
		methods: ['POST'],
		requestBody: 'streaming',
		fetch: (request) => handleUpload(ctx, request)
	}), 'file-manager: upload route');
	ctx.effect(() => ctx.connection.fetch.register({
		path: DOWNLOAD_PATH,
		methods: ['GET'],
		requestBody: 'buffered',
		fetch: (request) => handleDownload(ctx, request)
	}), 'file-manager: download route');
	ctx.effect(() => ctx.connection.fetch.register({
		path: ZIP_PATH,
		methods: ['POST'],
		requestBody: 'buffered',
		fetch: (request) => handleZip(ctx, request)
	}), 'file-manager: selection zip route');
}
