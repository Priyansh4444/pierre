import type { ExtensionFormatMap, SupportedLanguages } from '../types';

const CUSTOM_EXTENSION_TO_FILE_FORMAT: Map<string, SupportedLanguages> =
  new Map();

let customExtensionsVersion = 0;

// Built-in extensions and exact file names, grouped by language and separated
// by spaces.
const LANGUAGE_FILE_NAMES = {
  '1c': '1c',
  abap: 'abap',
  'actionscript-3': 'as',
  ada: 'ada adb ads',
  'angular-html': 'component.html',
  'angular-ts': 'component.ts',
  apache: 'htaccess',
  apex: 'trigger',
  apl: 'apl',
  applescript: 'applescript scpt',
  ara: 'ara',
  asciidoc: 'adoc asciidoc',
  asm: 'asm',
  astro: 'astro',
  awk: 'awk',
  ballerina: 'bal',
  beancount: 'beancount',
  berry: 'be',
  bibtex: 'bib',
  bicep: 'bicep',
  blade: 'blade.php',
  bsl: 'bsl',
  c: 'c',
  cairo: 'cairo',
  cdc: 'cdc',
  clarity: 'clar',
  clojure: 'clj cljs cljc',
  cmake: 'cmake CMakeLists.txt',
  cmd: 'bat cmd',
  cobol: 'cob cbl cobol',
  codeowners: 'CODEOWNERS',
  coffeescript: 'coffee',
  cpp: 'cpp hpp cc cxx hh',
  cql: 'cql',
  crystal: 'cr',
  csharp: 'cs',
  css: 'css',
  csv: 'csv',
  cue: 'cue',
  cypher: 'cypher cyp',
  d: 'd',
  dart: 'dart',
  dax: 'dax',
  desktop: 'desktop',
  diff: 'diff patch',
  dockerfile: 'Dockerfile dockerfile',
  dotenv: 'env',
  'dream-maker': 'dm',
  edge: 'edge',
  elixir: 'ex exs',
  elm: 'elm',
  'emacs-lisp': 'el',
  erb: 'erb',
  erlang: 'erl hrl',
  f03: 'f03',
  f08: 'f08',
  f18: 'f18',
  f77: 'f77',
  fennel: 'fnl',
  fish: 'fish',
  'fortran-fixed-form': 'f for',
  'fortran-free-form': 'f90 f95',
  fsharp: 'fs fsi fsx',
  ftl: 'ftl',
  gdresource: 'tres res',
  gdscript: 'gd',
  gdshader: 'gdshader',
  genie: 'gs',
  gherkin: 'feature',
  'git-commit': 'COMMIT_EDITMSG',
  'git-rebase': 'git-rebase-todo',
  gleam: 'gleam',
  'glimmer-js': 'gjs',
  'glimmer-ts': 'gts',
  glsl: 'glsl vert frag',
  gnuplot: 'gp plt gnuplot',
  go: 'go',
  graphql: 'graphql gql',
  groovy: 'groovy gvy',
  hack: 'hack',
  haml: 'haml',
  handlebars: 'hbs handlebars',
  haskell: 'hs lhs',
  haxe: 'hx',
  hcl: 'hcl',
  hjson: 'hjson',
  hlsl: 'hlsl fx',
  html: 'html htm',
  http: 'http rest',
  hxml: 'hxml',
  hy: 'hy',
  imba: 'imba',
  ini: 'ini cfg',
  java: 'java',
  javascript: 'js mjs cjs',
  jinja: 'jinja jinja2 j2',
  jison: 'jison',
  json: 'json',
  json5: 'json5',
  jsonc: 'jsonc',
  jsonl: 'jsonl',
  jsonnet: 'jsonnet libsonnet',
  jssm: 'jssm',
  jsx: 'jsx',
  julia: 'jl',
  kotlin: 'kt',
  kts: 'kts',
  kusto: 'kql',
  lean4: 'lean',
  less: 'less',
  liquid: 'liquid',
  lisp: 'lisp cl lsp',
  lit: 'lit',
  llvm: 'll',
  log: 'log',
  logo: 'logo',
  lua: 'lua',
  luau: 'luau',
  makefile: 'Makefile mk makefile',
  markdown: 'md markdown',
  marko: 'marko',
  matlab: 'mat',
  mdc: 'mdc',
  mdx: 'mdx',
  mermaid: 'mmd mermaid',
  mipsasm: 'mips',
  mojo: 'mojo 🔥',
  move: 'move',
  narrat: 'nar',
  nextflow: 'nf',
  nginx: 'conf',
  nim: 'nim nims nimble',
  nix: 'nix',
  nushell: 'nu',
  'objective-cpp': 'h mm',
  ocaml: 'ml mli mll mly',
  odin: 'odin',
  pascal: 'pas p',
  perl: 'pm t',
  php: 'php phtml',
  plsql: 'pls',
  po: 'po',
  polar: 'polar',
  postcss: 'pcss',
  pot: 'pot',
  potx: 'potx',
  powerquery: 'pq pqm',
  powershell: 'ps1 psm1 psd1',
  prisma: 'prisma',
  prolog: 'pl pro P',
  properties: 'properties',
  protobuf: 'proto',
  pug: 'jade pug',
  puppet: 'pp',
  purescript: 'purs',
  // FIXME: Starlark files (BUCK through sky) should move to a Starlark file
  // type if/when one appears in shiki. For now, Starlark is highlighted like
  // the Python subset it is.
  python:
    'py pyw pyi BUCK BUILD PACKAGE WORKSPACE Tiltfile bazel bxl bzl bzlmod star sky',
  ql: 'ql',
  qml: 'qml',
  qmldir: 'qmldir',
  qss: 'qss',
  r: 'r R',
  racket: 'rkt rktl',
  raku: 'raku p6 pl6',
  razor: 'razor cshtml',
  reg: 'reg',
  regexp: 'regex',
  rel: 'rel',
  riscv: 's',
  rst: 'rst',
  ruby: 'rb rbw rake gemspec jbuilder builder rabl arb ru podspec Gemfile Rakefile Guardfile Capfile Berksfile Brewfile Vagrantfile Thorfile Appraisals Dangerfile',
  rust: 'rs',
  sas: 'sas',
  sass: 'sass',
  scala: 'scala sc',
  scheme: 'scm ss sld',
  scss: 'scss',
  sdbl: 'sdbl',
  shader: 'shadergraph',
  shaderlab: 'shader',
  smalltalk: 'st',
  solidity: 'sol',
  soy: 'soy',
  sparql: 'sparql rq',
  splunk: 'spl',
  sql: 'sql',
  'ssh-config': 'config',
  stata: 'do ado dta',
  stylus: 'styl stylus',
  svelte: 'svelte',
  swift: 'swift',
  'system-verilog': 'sv svh',
  systemd: 'service socket device timer',
  talonscript: 'talon',
  tasl: 'tasl',
  tcl: 'tcl',
  templ: 'templ',
  tex: 'cls tex ltx sty',
  tf: 'tf',
  tfvars: 'tfvars',
  toml: 'toml',
  tsv: 'tsv',
  tsx: 'tsx',
  turtle: 'ttl',
  twig: 'twig',
  typescript: 'ts mts cts',
  typespec: 'tsp',
  typst: 'typ',
  v: 'vv',
  vala: 'vala vapi',
  vb: 'vb vbs bas',
  verilog: 'v vh',
  vhdl: 'vhd vhdl',
  vimscript: 'vim',
  vue: 'vue',
  'vue-vine': 'vine.ts',
  vyper: 'vy',
  wasm: 'wasm wat',
  wgsl: 'wgsl',
  wikitext: 'wiki mediawiki',
  wit: 'wit',
  wolfram: 'm wl nb',
  xml: 'xml',
  xsl: 'xsl xslt',
  yaml: 'yaml',
  yml: 'yml',
  zenscript: 'zs',
  zig: 'zig',
  zsh: 'sh bash zsh',
  文言: 'wy',
} satisfies Partial<Record<SupportedLanguages, string>>;

export const EXTENSION_TO_FILE_FORMAT: ExtensionFormatMap = {};
for (const [lang, names] of Object.entries(LANGUAGE_FILE_NAMES)) {
  for (const name of names.split(' ')) {
    EXTENSION_TO_FILE_FORMAT[name] = lang;
  }
}

export function getFiletypeFromFileName(fileName: string): SupportedLanguages {
  const format = matchFiletypeFromName(fileName);
  if (format != null) {
    return format;
  }

  // Special files are keyed by their exact name (Dockerfile, CMakeLists.txt), but callers
  // routinely pass a repository-relative path. Retry on the basename so `docker/Dockerfile`
  // resolves the same way a top-level `Dockerfile` does. The retry only runs once the full
  // path has matched nothing, so real extensions still win (e.g. `docker/Dockerfile.ts`).
  const baseName = fileName.split(/[/\\]/).pop() ?? fileName;
  return baseName === fileName
    ? 'text'
    : (matchFiletypeFromName(baseName) ?? 'text');
}

function matchFiletypeFromName(fileName: string): SupportedLanguages | null {
  if (CUSTOM_EXTENSION_TO_FILE_FORMAT.has(fileName)) {
    return CUSTOM_EXTENSION_TO_FILE_FORMAT.get(fileName) ?? 'text';
  }
  // Handle special files without extensions first
  if (Object.hasOwn(EXTENSION_TO_FILE_FORMAT, fileName)) {
    return EXTENSION_TO_FILE_FORMAT[fileName] ?? null;
  }

  // Try compound extensions first (e.g., .blade.php, .component.ts)
  const compoundMatch = fileName.match(/\.([^/\\]+\.[^/\\]+)$/);
  if (compoundMatch != null) {
    if (CUSTOM_EXTENSION_TO_FILE_FORMAT.has(compoundMatch[1])) {
      return CUSTOM_EXTENSION_TO_FILE_FORMAT.get(compoundMatch[1]) ?? 'text';
    }
    if (Object.hasOwn(EXTENSION_TO_FILE_FORMAT, compoundMatch[1])) {
      return EXTENSION_TO_FILE_FORMAT[compoundMatch[1]] ?? 'text';
    }
  }

  // Fall back to simple extension
  const simpleMatch = fileName.match(/\.([^.]+)$/)?.[1] ?? '';
  if (CUSTOM_EXTENSION_TO_FILE_FORMAT.has(simpleMatch)) {
    return CUSTOM_EXTENSION_TO_FILE_FORMAT.get(simpleMatch) ?? 'text';
  }
  return Object.hasOwn(EXTENSION_TO_FILE_FORMAT, simpleMatch)
    ? (EXTENSION_TO_FILE_FORMAT[simpleMatch] ?? 'text')
    : null;
}

export function replaceCustomExtensions(
  version: number,
  map: ExtensionFormatMap
): boolean {
  if (version <= customExtensionsVersion) {
    return false;
  }
  CUSTOM_EXTENSION_TO_FILE_FORMAT.clear();
  for (const key in map) {
    const lang = map[key];
    if (lang != null) {
      CUSTOM_EXTENSION_TO_FILE_FORMAT.set(key, lang);
    }
  }
  customExtensionsVersion = version;
  return true;
}

export function getCustomExtensionsVersion(): number {
  return customExtensionsVersion;
}

export function setCustomExtension(
  key: string,
  lang: SupportedLanguages
): boolean {
  const existing = CUSTOM_EXTENSION_TO_FILE_FORMAT.get(key);
  if (existing === lang) {
    return false;
  }
  if (existing != null) {
    console.warn(
      `setCustomExtension: overriding custom mapping for "${key}" from "${existing}" to "${lang}"`
    );
  }
  CUSTOM_EXTENSION_TO_FILE_FORMAT.set(key, lang);
  customExtensionsVersion++;
  return true;
}

export function getCustomExtensionsMap(): ExtensionFormatMap {
  return Object.fromEntries(CUSTOM_EXTENSION_TO_FILE_FORMAT);
}
