import { readdir, stat } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { LspConnection, canonicalizeWorkspace, normalizeLocations, readHostSource } from "@deepseek-ai/dsh-lsp-stdio";
//#region src/project.ts
/** Bounded workspace configuration discovery shared by every navigator UI. */
const CPP = /* @__PURE__ */ new Set([
	".c",
	".cc",
	".cpp",
	".cxx",
	".h",
	".hh",
	".hpp",
	".hxx",
	".inc",
	".inl",
	".ipp",
	".tpp"
]);
const TS = /* @__PURE__ */ new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs"
]);
const SKIP = /* @__PURE__ */ new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"vendor",
	"third_party"
]);
async function isFile(path) {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}
async function ancestorFile(cwd, sourcePath, names) {
	let current = dirname(sourcePath);
	for (;;) {
		for (const name of names) {
			const candidate = join(current, name);
			if (await isFile(candidate)) return candidate;
		}
		if (current === cwd) return null;
		const parent = dirname(current);
		if (parent === current || relative(cwd, parent).startsWith("..")) return null;
		current = parent;
	}
}
/** Find a C++ compilation database without an unbounded workspace crawl. */
async function findCompilationDatabase(cwd) {
	for (const path of [
		join(cwd, "compile_commands.json"),
		join(cwd, "build", "compile_commands.json"),
		join(cwd, "out", "build", "compile_commands.json")
	]) if (await isFile(path)) return path;
	const queue = [{
		path: cwd,
		depth: 0
	}];
	let visited = 0;
	while (queue.length > 0 && visited < 500) {
		const current = queue.shift();
		if (current === void 0) break;
		visited += 1;
		let entries;
		try {
			entries = await readdir(current.path, { withFileTypes: true });
		} catch {
			continue;
		}
		if (entries.some((entry) => entry.isFile() && entry.name === "compile_commands.json")) return join(current.path, "compile_commands.json");
		if (current.depth === 4) continue;
		const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP.has(entry.name)).sort((left, right) => (/^(build|out|cmake-build)/i.test(left.name) ? 0 : 1) - (/^(build|out|cmake-build)/i.test(right.name) ? 0 : 1) || left.name.localeCompare(right.name));
		for (const directory of directories) queue.push({
			path: join(current.path, directory.name),
			depth: current.depth + 1
		});
	}
	return null;
}
/** Detect a source file's language server and project file. */
async function detectProject(cwd, sourcePath) {
	const extension = extname(sourcePath).toLowerCase();
	if (CPP.has(extension)) return {
		language: "cpp",
		server: "clangd",
		configPath: await ancestorFile(cwd, sourcePath, ["compile_commands.json"]) ?? await findCompilationDatabase(cwd)
	};
	if (extension === ".py" || extension === ".pyi") return {
		language: "python",
		server: "pyright",
		configPath: await ancestorFile(cwd, sourcePath, [
			"pyrightconfig.json",
			"pyproject.toml",
			"setup.cfg"
		])
	};
	if (TS.has(extension)) return {
		language: "typescript",
		server: "typescript-language-server",
		configPath: await ancestorFile(cwd, sourcePath, ["tsconfig.json", "jsconfig.json"])
	};
	return {
		language: null,
		server: null,
		configPath: null
	};
}
//#endregion
//#region src/persistent-server.ts
/** Persistent document lifecycle on top of the public DSH stdio transport. */
const LANGUAGE_ID = {
	cpp: "cpp",
	python: "python",
	typescript: "typescript"
};
function commandFor(project) {
	switch (project.server) {
		case "clangd": return {
			command: process.execPath,
			args: [fileURLToPath(new URL("../scripts/clangd-auto.mjs", import.meta.url)), "--background-index"]
		};
		case "pyright": return {
			command: "pyright-langserver",
			args: ["--stdio"]
		};
		case "typescript-language-server": return {
			command: "typescript-language-server",
			args: ["--stdio"]
		};
		case null: throw new Error("no language server is configured for this file");
	}
}
/** One initialized LSP process and the documents deliberately held open in it. */
var PersistentWorkspace = class {
	workspace;
	project;
	runtime;
	publish;
	connection;
	documents = /* @__PURE__ */ new Map();
	phase = "idle";
	message;
	chain = Promise.resolve();
	constructor(workspace, project, runtime, publish) {
		this.workspace = workspace;
		this.project = project;
		this.runtime = runtime;
		this.publish = publish;
	}
	/** Snapshot used by status routes and visual adapters. */
	status() {
		return {
			workspace: this.workspace.canonicalPath,
			server: this.project.server ?? "none",
			phase: this.phase,
			openDocuments: this.documents.size,
			...this.message === void 0 ? {} : { message: this.message }
		};
	}
	emit() {
		this.publish(this.status());
	}
	enqueue(work) {
		const result = this.chain.then(work);
		this.chain = result.then(() => void 0, () => void 0);
		return result;
	}
	async ensureConnection() {
		if (this.connection !== void 0 && !this.connection.failed) return this.connection;
		this.phase = "starting";
		this.message = void 0;
		this.emit();
		const launch = commandFor(this.project);
		const executable = await this.runtime.subprocess.resolveExecutable(launch.command, {});
		const connection = new LspConnection({
			command: executable,
			args: launch.args,
			cwd: this.workspace.canonicalPath,
			env: {},
			maxMessageBytes: 16e6,
			maxStderrBytes: 1e6,
			killGraceMs: 2e3,
			configuration: null
		}, (spec) => this.runtime.subprocess.spawn(spec), async (method) => {
			if (method === "workspace/configuration") return null;
			throw new Error(`unsupported language-server request "${method}"`);
		});
		try {
			const initialized = await connection.request("initialize", {
				processId: null,
				rootUri: this.workspace.fileUrl,
				workspaceFolders: [{
					uri: this.workspace.fileUrl,
					name: "workspace"
				}],
				capabilities: {
					general: { positionEncodings: ["utf-16"] },
					workspace: {
						workspaceFolders: true,
						configuration: true
					},
					textDocument: {
						synchronization: { dynamicRegistration: false },
						definition: { linkSupport: true }
					}
				},
				initializationOptions: null
			});
			if (initialized.capabilities?.positionEncoding !== void 0 && initialized.capabilities.positionEncoding !== "utf-16") throw new Error(`server selected unsupported position encoding ${initialized.capabilities.positionEncoding}`);
			await connection.notify("initialized", {});
			this.connection = connection;
			this.phase = "ready";
			this.emit();
			return connection;
		} catch (error) {
			connection.terminate();
			this.phase = "failed";
			this.message = error instanceof Error ? error.message : String(error);
			this.emit();
			throw error;
		}
	}
	/** Open a disk-backed document once. Call only inside this workspace queue. */
	async ensureDocument(path, retain) {
		const existing = this.documents.get(path);
		if (existing !== void 0) {
			if (retain) existing.references += 1;
			return existing;
		}
		const source = await readHostSource(this.runtime.fs, path, this.workspace, 4e6);
		const languageId = this.project.language === null ? "plaintext" : LANGUAGE_ID[this.project.language];
		await (await this.ensureConnection()).notify("textDocument/didOpen", { textDocument: {
			uri: source.fileUrl,
			languageId,
			version: 1,
			text: source.text
		} });
		const document = {
			uri: source.fileUrl,
			languageId,
			version: 1,
			text: source.text,
			references: retain ? 1 : 0
		};
		this.documents.set(path, document);
		this.emit();
		return document;
	}
	/** Open a disk-backed document once and retain it until an adapter closes it. */
	open(path) {
		return this.enqueue(async () => {
			await this.ensureDocument(path, true);
		});
	}
	/** Apply an editor's complete current text without closing its LSP document. */
	change(path, text) {
		return this.enqueue(async () => {
			const document = await this.ensureDocument(path, false);
			if (document.text === text) return;
			document.version += 1;
			document.text = text;
			await (await this.ensureConnection()).notify("textDocument/didChange", {
				textDocument: {
					uri: document.uri,
					version: document.version
				},
				contentChanges: [{ text }]
			});
		});
	}
	/** Release one editor reference, closing the document when the last tab leaves. */
	close(path) {
		return this.enqueue(async () => {
			const document = this.documents.get(path);
			if (document === void 0) return;
			document.references -= 1;
			if (document.references > 0) return;
			this.documents.delete(path);
			if (this.connection !== void 0 && !this.connection.failed) await this.connection.notify("textDocument/didClose", { textDocument: { uri: document.uri } });
			this.emit();
		});
	}
	/** Resolve a definition while retaining the source document in the LSP process. */
	definition(path, position) {
		return this.enqueue(async () => {
			const document = await this.ensureDocument(path, false);
			const payload = await (await this.ensureConnection()).request("textDocument/definition", {
				textDocument: { uri: document.uri },
				position
			});
			return normalizeLocations(payload);
		});
	}
	/** Terminate the process after closing the documents it owns. */
	async dispose() {
		await this.enqueue(async () => {
			const connection = this.connection;
			this.documents.clear();
			this.connection = void 0;
			if (connection !== void 0 && !connection.failed) try {
				await connection.request("shutdown", null);
				await connection.notify("exit", null);
			} catch {
				connection.terminate();
			}
			connection?.terminate();
			this.phase = "idle";
			this.emit();
		});
	}
};
/** Owns the persistent sessions for all workspaces in one code-navigator plugin instance. */
var PersistentNavigator = class {
	runtime;
	workspaces = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Set();
	constructor(runtime) {
		this.runtime = runtime;
	}
	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	publish = (status) => {
		for (const listener of this.listeners) listener(status);
	};
	/** Resolve one source into its stable workspace process slot. */
	async workspace(cwd, project) {
		const resolved = await canonicalizeWorkspace(this.runtime.fs, cwd);
		const existing = this.workspaces.get(resolved.canonicalPath);
		if (existing !== void 0) return existing;
		const created = new PersistentWorkspace(resolved, project, this.runtime, this.publish);
		this.workspaces.set(resolved.canonicalPath, created);
		return created;
	}
	/** Stop every owned server at plugin unload. */
	async dispose() {
		await Promise.allSettled([...this.workspaces.values()].map((workspace) => workspace.dispose()));
		this.workspaces.clear();
	}
};
//#endregion
//#region src/index.ts
/** Cordis loader name shown in startup diagnostics. */
const name = "code-navigator";
/** Host services required by the standalone provider. */
const inject = [
	"fs",
	"subprocess",
	"sessions",
	"webServer"
];
function runtimeOf(ctx) {
	return ctx;
}
function requireString(payload, key) {
	const value = payload?.[key];
	if (typeof value !== "string" || value === "") throw new Error(`missing or invalid "${key}"`);
	return value;
}
function positionOf(payload) {
	const value = payload?.position;
	const line = value?.line;
	const character = value?.character;
	if (typeof line !== "number" || typeof character !== "number" || !Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0) throw new Error("missing or invalid \"position\"");
	return {
		line,
		character
	};
}
async function readJson(req) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of req) {
		const encoded = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
		bytes += encoded.byteLength;
		if (bytes > 1048576) throw new Error("request body too large");
		chunks.push(encoded);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	return text.trim() === "" ? {} : JSON.parse(text);
}
function json(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}
function cwdOf(runtime, payload) {
	const sessionId = requireString(payload, "sessionId");
	const stored = runtime.sessions.get(sessionId)?.header.cwd;
	if (stored !== void 0 && stored !== "") return stored;
	return requireString(payload, "cwd");
}
/** Install an isolated persistent navigator. It does not mount, modify, or depend on any sidebar. */
async function apply(ctx) {
	const runtime = runtimeOf(ctx);
	const navigator = new PersistentNavigator({
		fs: runtime.fs,
		subprocess: runtime.subprocess
	});
	const service = {
		project: detectProject,
		async open(cwd, path) {
			const project = await detectProject(cwd, path);
			if (project.server === null) throw new Error(`unsupported source file "${path}"`);
			await (await navigator.workspace(cwd, project)).open(path);
		},
		async change(cwd, path, text) {
			const project = await detectProject(cwd, path);
			if (project.server === null) throw new Error(`unsupported source file "${path}"`);
			await (await navigator.workspace(cwd, project)).change(path, text);
		},
		async close(cwd, path) {
			const project = await detectProject(cwd, path);
			if (project.server === null) return;
			await (await navigator.workspace(cwd, project)).close(path);
		},
		async definition(cwd, path, position) {
			const project = await detectProject(cwd, path);
			if (project.server === null) return [];
			return await (await navigator.workspace(cwd, project)).definition(path, position);
		},
		subscribe: (listener) => navigator.subscribe(listener)
	};
	ctx.provide("codeNavigator", service);
	ctx.effect(() => runtime.webServer.register({
		kind: "prefix",
		path: "/code-navigator/api",
		async handler(req, res) {
			if (req.method !== "POST") {
				json(res, 405, {
					ok: false,
					error: "method not allowed"
				});
				return;
			}
			const method = new URL(req.url ?? "/", "http://dsh.internal").pathname.slice(20);
			try {
				const payload = await readJson(req);
				const cwd = cwdOf(runtime, payload);
				const path = requireString(payload, "path");
				switch (method) {
					case "project":
						json(res, 200, {
							ok: true,
							value: await service.project(cwd, path)
						});
						return;
					case "open":
						await service.open(cwd, path);
						json(res, 200, {
							ok: true,
							value: null
						});
						return;
					case "change":
						await service.change(cwd, path, requireString(payload, "text"));
						json(res, 200, {
							ok: true,
							value: null
						});
						return;
					case "close":
						await service.close(cwd, path);
						json(res, 200, {
							ok: true,
							value: null
						});
						return;
					case "definition":
						json(res, 200, {
							ok: true,
							value: await service.definition(cwd, path, positionOf(payload))
						});
						return;
					default:
						json(res, 404, {
							ok: false,
							error: "unknown code navigator API method"
						});
						return;
				}
			} catch (error) {
				json(res, 400, {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}
	}), "dsh-code-navigator: API routes");
	ctx.effect(() => () => navigator.dispose(), "dsh-code-navigator: dispose persistent servers");
}
//#endregion
export { apply, inject, name };
