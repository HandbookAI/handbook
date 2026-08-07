/**
 * Java adapter (tree-sitter grammar `java`).
 *
 * Two passes, like every adapter:
 *   1. scan each file: `package`, imports, every declared type (nested types
 *      included) with its supertypes, field types, methods, constructors and
 *      initializer blocks;
 *   2. resolve call sites (`m()`, `this.m()`, `super.m()`, `this.field.m()`,
 *      `local.m()`, `Type.staticM()`, `new T()`, `super(...)`) against the
 *      cross-module indexes into typed {@link CallEdge}s.
 *
 * What makes Java full fidelity is that it is EXPLICITLY typed: fields,
 * parameters and local variables all carry a declared type, so a receiver's
 * type is read off the source rather than guessed. Three Java-specific facts
 * shape the resolver:
 *
 * - **The package, not the file, is the visibility unit.** A sibling class in
 *   the same package is referable unqualified with no import at all, so type
 *   resolution consults the declared `package` first and only then imports.
 *   That is also why this adapter keeps a private package→type index instead of
 *   using the spine's bare-name `typeToModule`: simple names like `Config` or
 *   `Handler` repeat across packages in real Java trees, and a bare-name table
 *   would silently pick whichever one was scanned first.
 * - **Static calls target internal functions.** `Helpers.greet()` on a scanned
 *   class resolves to `internal_func` at `<module>.Helpers.greet`, following the
 *   TypeScript adapter and the SP2 decision not to add a `static_method` kind.
 * - **A constructor's name is its class name**, so `new Engine()` resolves to
 *   `<module>.Engine.Engine`; a class with no explicit constructor gets that
 *   node synthesized by the graph builder, exactly like Python's `__init__`.
 *
 * Java has no `async`/`await`, so `isAsync`/`isAwait` are always false — no
 * keyword is invented to fill those fields.
 *
 * Known limits, stated rather than hidden:
 *   - overloads share one id, so the spine dedupe keeps the last definition (the
 *     same trade TypeScript overloads already make);
 *   - local and anonymous class bodies are skipped: they rebind `this`, and
 *     attributing their `this.m()` calls to the enclosing method's class would
 *     be wrong. Lambdas, which do not rebind `this`, ARE walked;
 *   - a bare name introduced by a static on-demand import (`import static
 *     Type.*`) stays unresolved — attributing it needs a full member index;
 *   - a call inside a field initializer produces no edge, because there is no
 *     enclosing function node to hang it on (as in TypeScript);
 *   - `var` is resolved only when the initializer is a `new T()`; no return-type
 *     inference is attempted.
 */
import type { Node } from 'web-tree-sitter';
import type { AdapterCapabilities, CallEdge, CallType } from '@handbook/core';
import { truncate } from '@handbook/core';
import { dedupeFunctionsById } from '../adapter.js';
import { fieldText, lineEnd, lineStart, walk } from '../tsx-util.js';
import {
  boundaryOf,
  resolveOwnMethod,
  resolveViaImport,
  unresolvedOf,
  SpineAdapter,
  type BaseScan,
  type ImportResolveOptions,
  type LanguageSpec,
  type Resolved,
  type StandardIndexes,
} from '../spine.js';

/** Types that name no scannable class: primitives, `var`, and JDK ubiquities. */
const GENERIC_TYPES = new Set([
  'var', 'void', 'boolean', 'byte', 'short', 'int', 'long', 'char', 'float', 'double',
  'Boolean', 'Byte', 'Short', 'Integer', 'Long', 'Character', 'Float', 'Double',
  'String', 'CharSequence', 'Object', 'Number', 'Class', 'Iterable', 'Iterator',
  'Collection', 'List', 'ArrayList', 'Map', 'HashMap', 'Set', 'HashSet', 'Optional', 'Stream',
]);

/** Build outputs; Gradle/Maven put generated sources under these too. */
const EXTRA_SKIP_DIRS = ['target', 'build', 'out', '.gradle'];

const TYPE_DECLARATIONS = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
  'annotation_type_declaration',
]);

/**
 * Scopes skipped while walking a body. Local and anonymous class bodies rebind
 * `this`, so their members' calls must not be attributed to the enclosing
 * method's class. Lambdas are deliberately absent: a lambda shares the
 * enclosing `this`, and it gets no node of its own, so walking into it is the
 * only way its calls are recorded at all.
 */
const NESTED_SCOPES = new Set([
  'class_body',
  'interface_body',
  'enum_body',
  'annotation_type_body',
  'method_declaration',
  'constructor_declaration',
]);

/**
 * Initializer blocks have no source name. The JVM calls them `<clinit>`/
 * `<init>`, but angle brackets travel badly through ids that end up in DOT and
 * Markdown, so plain identifiers stand in.
 */
const STATIC_INIT = 'static_init';
const INSTANCE_INIT = 'instance_init';

interface FnContext {
  body: Node;
  className: string;
  /** parameter AND typed-local names → bare type name. */
  types: Map<string, string>;
}

interface ModuleScan extends BaseScan {
  /**
   * `imports`: local name → the imported fully qualified name (a single-member
   * static import lands here too, keyed by the member name).
   * `ownerMethods`: declared type → its callable member names.
   * `fieldTypes`: `Type.field` → bare type name.
   * `freeFunctions` stays empty: Java has no functions outside a type.
   */
  fnContext: Map<string, FnContext>;
  /** Declared `package`; '' is the default (unnamed) package. */
  packageName: string;
  /** type → direct supertype names, `extends` and `implements` together. */
  supertypeNames: Map<string, string[]>;
  /** type → the `extends` class only, which is what `super(...)` targets. */
  superclassName: Map<string, string>;
  /** Packages made visible unqualified by an `import pkg.*`. */
  wildcardPackages: string[];
}

/** One type, located: which module declares it and under what simple name. */
interface TypeRef {
  module: string;
  type: string;
}

interface JavaIndexes {
  /** `<package>.<Type>` (bare name in the default package) → declaring module. */
  moduleOfFqn: Map<string, string>;
  /** package → simple type name → declaring module (unqualified visibility). */
  packageTypes: Map<string, Map<string, string>>;
  /** `<module>.<Type>` → its direct supertypes that are inside the scan set. */
  supertypes: Map<string, TypeRef[]>;
  /** `<module>.<Type>.<field>` → bare type name, so heirs can read it. */
  fieldTypes: Map<string, string>;
}

export function moduleIdForFile(file: string): string {
  return file.replace(/\.java$/, '').split('/').join('.');
}

/**
 * Peel a type node down to the simple name that could name a class:
 * `List<Engine>` → `List`, `Engine[]` → `Engine`, `com.x.Engine` → `Engine`.
 * Primitives and other unnamed types yield ''.
 */
function bareTypeName(typeNode: Node | null): string {
  if (!typeNode) return '';
  switch (typeNode.type) {
    case 'type_identifier':
      return typeNode.text;
    case 'array_type':
      return bareTypeName(typeNode.childForFieldName('element'));
    case 'generic_type':
      // children are the head type plus `type_arguments`.
      return bareTypeName(typeNode.namedChildren.find((c) => c && c.type !== 'type_arguments') ?? null);
    case 'scoped_type_identifier': {
      // `com.demo.engine.Engine` — the last direct `type_identifier` is the type.
      const segments = typeNode.namedChildren.filter((c): c is Node => c?.type === 'type_identifier');
      return segments.at(-1)?.text ?? '';
    }
    case 'catch_type':
      // `catch (IOException | SQLException e)` — the first alternative is enough.
      return bareTypeName(typeNode.namedChildren.find((c) => c !== null) ?? null);
    default:
      return '';
  }
}

/** {@link bareTypeName} filtered to types worth learning as a receiver type. */
function learnedType(typeNode: Node | null, typeVars: ReadonlySet<string>): string {
  const bare = bareTypeName(typeNode);
  if (!bare || GENERIC_TYPES.has(bare) || typeVars.has(bare)) return '';
  return bare;
}

/** Names bound by `<T, U extends X>` — they name no class and must not be learned. */
function typeParameterNames(node: Node): Set<string> {
  const names = new Set<string>();
  const params = node.namedChildren.find((c) => c?.type === 'type_parameters');
  if (!params) return names;
  for (const param of params.namedChildren) {
    if (param?.type !== 'type_parameter') continue;
    const id = param.namedChildren.find((c) => c?.type === 'type_identifier');
    if (id) names.add(id.text);
  }
  return names;
}

/** `@Test` / `@Service("x")` → `Test` / `Service("x")`, matching Python's shape. */
function annotationsOf(node: Node): string[] {
  const modifiers = node.namedChildren.find((c) => c?.type === 'modifiers');
  if (!modifiers) return [];
  const found: string[] = [];
  for (const child of modifiers.namedChildren) {
    if (child?.type !== 'annotation' && child?.type !== 'marker_annotation') continue;
    found.push(child.text.replace(/^@/, '').replace(/\s+/g, ' ').trim());
  }
  return found;
}

function hasStaticModifier(node: Node): boolean {
  const modifiers = node.namedChildren.find((c) => c?.type === 'modifiers');
  return modifiers?.children.some((c) => c?.type === 'static') ?? false;
}

function collectImport(node: Node, scan: ModuleScan): void {
  const isStatic = node.children.some((c) => c?.type === 'static');
  const onDemand = node.namedChildren.some((c) => c?.type === 'asterisk');
  const path = node.namedChildren.find((c) => c && c.type !== 'asterisk');
  if (!path) return;
  if (onDemand) {
    // `import pkg.*` makes every type of `pkg` visible unqualified. A static
    // on-demand import instead brings in MEMBERS of one type, which cannot be
    // attributed without a full member index — recorded nowhere on purpose.
    if (!isStatic) scan.wildcardPackages.push(path.text);
    return;
  }
  const local = fieldText(path, 'name') || path.text;
  scan.imports.set(local, path.text);
}

/** `extends` + `implements`, peeled to simple names. */
function supertypeNamesOf(decl: Node): { supertypes: string[]; superclass: string } {
  const supertypes: string[] = [];
  let superclass = '';
  for (const child of decl.namedChildren) {
    if (!child) continue;
    if (child.type !== 'superclass' && child.type !== 'super_interfaces' && child.type !== 'extends_interfaces') {
      continue;
    }
    for (const inner of child.namedChildren) {
      if (!inner) continue;
      const candidates = inner.type === 'type_list' ? inner.namedChildren : [inner];
      for (const candidate of candidates) {
        const name = bareTypeName(candidate);
        if (!name) continue;
        supertypes.push(name);
        if (child.type === 'superclass') superclass = name;
      }
    }
  }
  return { supertypes, superclass };
}

/** A type body's members, unwrapping an enum's `enum_body_declarations`. */
function membersOf(body: Node): Node[] {
  const members: Node[] = [];
  for (const child of body.namedChildren) {
    if (!child) continue;
    if (child.type === 'enum_body_declarations') {
      for (const inner of child.namedChildren) if (inner) members.push(inner);
    } else {
      members.push(child);
    }
  }
  return members;
}

function scanFieldDeclaration(
  scan: ModuleScan,
  node: Node,
  className: string,
  typeVars: ReadonlySet<string>,
): void {
  const type = learnedType(node.childForFieldName('type'), typeVars);
  if (!type) return;
  // `private Engine a, b;` declares two fields of the same type.
  for (const child of node.namedChildren) {
    if (child?.type !== 'variable_declarator') continue;
    const name = fieldText(child, 'name');
    if (name) scan.fieldTypes.set(`${className}.${name}`, type);
  }
}

/**
 * Declared types of local variables: `Engine e = …`, `for (Engine e : …)`,
 * `try (Engine e = …)` and `catch (IOException e)`. Block scoping is ignored —
 * the first declaration of a name wins for the whole body, which costs
 * precision only when one method reuses a name at two different types.
 */
function localTypes(body: Node, typeVars: ReadonlySet<string>): Map<string, string> {
  const locals = new Map<string, string>();
  const learn = (name: string, typeNode: Node | null, value: Node | null): void => {
    if (!name || locals.has(name)) return;
    let type = learnedType(typeNode, typeVars);
    // `var e = new Engine()` — the initializer names the type `var` hides.
    if (!type && value?.type === 'object_creation_expression') {
      type = learnedType(value.childForFieldName('type'), typeVars);
    }
    if (type) locals.set(name, type);
  };
  walk(body, (node) => {
    if (NESTED_SCOPES.has(node.type)) return false;
    if (node.type === 'local_variable_declaration') {
      const typeNode = node.childForFieldName('type');
      for (const child of node.namedChildren) {
        if (child?.type !== 'variable_declarator') continue;
        learn(fieldText(child, 'name'), typeNode, child.childForFieldName('value'));
      }
    } else if (node.type === 'enhanced_for_statement' || node.type === 'resource') {
      learn(fieldText(node, 'name'), node.childForFieldName('type'), node.childForFieldName('value'));
    } else if (node.type === 'catch_formal_parameter') {
      learn(fieldText(node, 'name'), node.namedChildren.find((c) => c?.type === 'catch_type') ?? null, null);
    }
    return undefined;
  });
  return locals;
}

/** All `this.<field>` accesses anywhere inside `node`. */
function thisFieldsIn(node: Node): string[] {
  const hits: string[] = [];
  walk(node, (n) => {
    if (n.type === 'field_access' && n.childForFieldName('object')?.type === 'this') {
      const field = fieldText(n, 'field');
      if (field) hits.push(field);
    }
  });
  return hits;
}

/** Collect `this.x` reads/writes inside a body (nested type bodies skipped). */
function trackThisAttrs(body: Node): { reads: string[]; writes: string[] } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  walk(body, (node) => {
    if (NESTED_SCOPES.has(node.type)) return false;
    if (node.type === 'assignment_expression') {
      const compound = fieldText(node, 'operator') !== '=';
      const left = node.childForFieldName('left');
      if (left) {
        for (const field of thisFieldsIn(left)) {
          writes.add(field);
          if (compound) reads.add(field);
        }
      }
      const right = node.childForFieldName('right');
      if (right) for (const field of thisFieldsIn(right)) reads.add(field);
      return false;
    }
    if (node.type === 'update_expression') {
      // `this.n++` reads and writes in one go.
      for (const field of thisFieldsIn(node)) {
        reads.add(field);
        writes.add(field);
      }
      return false;
    }
    if (node.type === 'field_access') {
      for (const field of thisFieldsIn(node)) reads.add(field);
      return false;
    }
    return undefined;
  });
  return { reads: [...reads].sort(), writes: [...writes].sort() };
}

interface RecordOptions {
  /** The declaration, annotations included — the signature is sliced from it. */
  node: Node;
  body: Node | null;
  name: string;
  className: string;
  /** Type variables in scope, which must not be mistaken for classes. */
  typeVars: ReadonlySet<string>;
  file: string;
  /** false for initializer blocks: they are not callable by name. */
  callable: boolean;
  /** Overrides the `static` modifier lookup (a static initializer has none). */
  isStatic?: boolean;
}

function recordFunction(scan: ModuleScan, opts: RecordOptions): void {
  const { node, body, name, className, file } = opts;
  if (!name) return;
  const qualname = `${className}.${name}`;
  const id = `${scan.moduleId}.${qualname}`;
  const isStatic = opts.isStatic ?? hasStaticModifier(node);
  const typeVars = new Set([...opts.typeVars, ...typeParameterNames(node)]);

  const params = new Map<string, string>();
  const paramsNode = node.childForFieldName('parameters');
  for (const param of paramsNode?.namedChildren ?? []) {
    if (!param) continue;
    if (param.type === 'formal_parameter') {
      const type = learnedType(param.childForFieldName('type'), typeVars);
      const paramName = fieldText(param, 'name');
      if (type && paramName) params.set(paramName, type);
    } else if (param.type === 'spread_parameter') {
      // `T... xs` — the declared type is the element type, and the name sits in
      // a `variable_declarator` rather than a `name` field.
      const type = learnedType(
        param.namedChildren.find((c) => c && c.type !== 'variable_declarator') ?? null,
        typeVars,
      );
      const declarator = param.namedChildren.find((c) => c?.type === 'variable_declarator');
      const paramName = declarator ? fieldText(declarator, 'name') : '';
      if (type && paramName) params.set(paramName, type);
    }
  }

  const types = new Map(params);
  if (body) {
    for (const [local, type] of localTypes(body, typeVars)) {
      if (!types.has(local)) types.set(local, type);
    }
  }

  const headerEnd = body ? body.startIndex : node.endIndex;
  const header = node.text.slice(0, Math.max(0, headerEnd - node.startIndex));
  const { reads, writes } = body ? trackThisAttrs(body) : { reads: [], writes: [] };

  if (opts.callable) scan.ownerMethods.get(className)?.add(name);

  scan.functions.push({
    id,
    name,
    qualname,
    file,
    lineStart: lineStart(node),
    lineEnd: lineEnd(node),
    signature: truncate(header.replace(/\s+/g, ' ').trim(), 200),
    isAsync: false,
    // Everything Java declares lives in a type, so `isMethod` carries the one
    // distinction that is still information: instance member vs static member.
    isMethod: !isStatic,
    className,
    decorators: annotationsOf(node),
    kind: 'internal',
    synthetic: false,
    selfAttrsRead: reads,
    selfAttrsWritten: writes,
    paramTypes: Object.fromEntries(params),
  });
  if (body) scan.fnContext.set(id, { body, className, types });
}

/** One top-level type declaration and, iteratively, the types nested in it. */
function scanTypeDeclaration(scan: ModuleScan, root: Node, file: string): void {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const decl = stack.pop();
    if (!decl) continue;
    const className = fieldText(decl, 'name');
    if (!className) continue;
    // Nested types are keyed by their simple name, like every other type: that
    // is also how Java source refers to them once inside the enclosing type.
    if (!scan.ownerMethods.has(className)) scan.ownerMethods.set(className, new Set());
    const { supertypes, superclass } = supertypeNamesOf(decl);
    if (supertypes.length > 0) scan.supertypeNames.set(className, supertypes);
    if (superclass) scan.superclassName.set(className, superclass);
    const typeVars = typeParameterNames(decl);

    if (decl.type === 'record_declaration') {
      // `record Point(int x, Engine e)` — the components are implicit fields.
      for (const component of decl.childForFieldName('parameters')?.namedChildren ?? []) {
        if (component?.type !== 'formal_parameter') continue;
        const type = learnedType(component.childForFieldName('type'), typeVars);
        const name = fieldText(component, 'name');
        if (type && name) scan.fieldTypes.set(`${className}.${name}`, type);
      }
    }

    const body = decl.childForFieldName('body');
    if (!body) continue;
    for (const member of membersOf(body)) {
      if (TYPE_DECLARATIONS.has(member.type)) {
        stack.push(member);
      } else if (member.type === 'field_declaration') {
        scanFieldDeclaration(scan, member, className, typeVars);
      } else if (
        member.type === 'method_declaration' ||
        member.type === 'constructor_declaration' ||
        // `record Point(int x) { Point { … } }` — a compact constructor takes the
        // record's components implicitly, so it declares no parameter list.
        member.type === 'compact_constructor_declaration'
      ) {
        recordFunction(scan, {
          node: member,
          body: member.childForFieldName('body'),
          // A constructor's source name IS the class name.
          name: fieldText(member, 'name'),
          className,
          typeVars,
          file,
          callable: true,
        });
      } else if (member.type === 'static_initializer' || member.type === 'block') {
        recordFunction(scan, {
          node: member,
          body: member.type === 'block' ? member : (member.namedChildren.find((c) => c?.type === 'block') ?? null),
          name: member.type === 'block' ? INSTANCE_INIT : STATIC_INIT,
          className,
          typeVars,
          file,
          // Not reachable by name, so it must not join the type's method set.
          callable: false,
          isStatic: member.type === 'static_initializer',
        });
      }
    }
  }
}

function buildIndexes(scans: readonly ModuleScan[]): JavaIndexes {
  const moduleOfFqn = new Map<string, string>();
  const packageTypes = new Map<string, Map<string, string>>();
  const fieldTypes = new Map<string, string>();
  for (const scan of scans) {
    let byName = packageTypes.get(scan.packageName);
    if (!byName) {
      byName = new Map<string, string>();
      packageTypes.set(scan.packageName, byName);
    }
    for (const type of scan.ownerMethods.keys()) {
      const fqn = scan.packageName ? `${scan.packageName}.${type}` : type;
      if (!moduleOfFqn.has(fqn)) moduleOfFqn.set(fqn, scan.moduleId);
      if (!byName.has(type)) byName.set(type, scan.moduleId);
    }
    for (const [key, type] of scan.fieldTypes) fieldTypes.set(`${scan.moduleId}.${key}`, type);
  }

  const indexes: JavaIndexes = { moduleOfFqn, packageTypes, supertypes: new Map(), fieldTypes };
  // Supertype names are resolved with the DECLARING file's imports and package,
  // so this second pass needs the tables above to be complete first.
  for (const scan of scans) {
    for (const [type, names] of scan.supertypeNames) {
      const refs: TypeRef[] = [];
      for (const name of names) {
        const module = moduleOfType(name, scan, indexes);
        if (module) refs.push({ module, type: name });
      }
      if (refs.length > 0) indexes.supertypes.set(`${scan.moduleId}.${type}`, refs);
    }
  }
  return indexes;
}

/**
 * The module declaring the type visible as `name` from `scan`, in Java's own
 * order: this file, then the package (no import needed), then a single-type
 * import, then an on-demand import. Undefined means "not in the scan set" —
 * including the imported-but-unscanned case, where the caller has the import
 * path to report as a boundary.
 */
function moduleOfType(name: string, scan: ModuleScan, own: JavaIndexes): string | undefined {
  if (scan.ownerMethods.has(name)) return scan.moduleId;
  const sibling = own.packageTypes.get(scan.packageName)?.get(name);
  if (sibling) return sibling;
  const imported = scan.imports.get(name);
  if (imported) return own.moduleOfFqn.get(imported);
  for (const pkg of scan.wildcardPackages) {
    const module = own.moduleOfFqn.get(`${pkg}.${name}`);
    if (module) return module;
  }
  return undefined;
}

/** Breadth-first supertype closure, nearest first; cycle-safe. */
function ancestorsOf(start: TypeRef, own: JavaIndexes): TypeRef[] {
  const seen = new Set([`${start.module}.${start.type}`]);
  const order: TypeRef[] = [];
  const queue: TypeRef[] = [start];
  while (queue.length > 0) {
    const ref = queue.shift();
    if (!ref) continue;
    for (const parent of own.supertypes.get(`${ref.module}.${ref.type}`) ?? []) {
      const key = `${parent.module}.${parent.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      order.push(parent);
      queue.push(parent);
    }
  }
  return order;
}

/** Where `method` is declared: the type itself, or its nearest scanned ancestor. */
function declaringType(
  ref: TypeRef,
  method: string,
  std: StandardIndexes,
  own: JavaIndexes,
  opts: { skipSelf?: boolean } = {},
): TypeRef | undefined {
  const declares = (candidate: TypeRef): boolean =>
    std.typeMethods.get(`${candidate.module}.${candidate.type}`)?.has(method) ?? false;
  if (!opts.skipSelf && declares(ref)) return ref;
  return ancestorsOf(ref, own).find(declares);
}

/**
 * `<receiver of type `type`>.<method>()`. A learned type outside the scan set is
 * a boundary (real information); inside it, the call lands on whichever type
 * actually declares the method.
 */
function resolveOnType(
  type: string,
  method: string,
  callType: CallType,
  scan: ModuleScan,
  std: StandardIndexes,
  own: JavaIndexes,
): Resolved {
  const module = moduleOfType(type, scan, own);
  if (!module) return boundaryOf(scan.imports.get(type) ?? type, method);
  const declaring = declaringType({ module, type }, method, std, own) ?? { module, type };
  return { calleeId: `${declaring.module}.${declaring.type}.${method}`, callType };
}

/** A field's declared type, including fields inherited from scanned ancestors. */
function fieldTypeOf(className: string, field: string, scan: ModuleScan, own: JavaIndexes): string {
  const direct = scan.fieldTypes.get(`${className}.${field}`);
  if (direct) return direct;
  for (const ancestor of ancestorsOf({ module: scan.moduleId, type: className }, own)) {
    const inherited = own.fieldTypes.get(`${ancestor.module}.${ancestor.type}.${field}`);
    if (inherited) return inherited;
  }
  return '';
}

/**
 * How the spine reads Java's import table for a BARE call. Only a single-member
 * static import can put a callable name in scope unqualified, and its import
 * value is `<owning type FQN>.<member>` — so the "free function" branch looks
 * the member up on that type.
 */
function importOptions(std: StandardIndexes, own: JavaIndexes): ImportResolveOptions {
  return {
    capitalizedTypesOnly: true,
    freeFunctionId: (source, leaf) => {
      const module = own.moduleOfFqn.get(source);
      if (!module) return undefined;
      const type = source.slice(source.lastIndexOf('.') + 1);
      const declaring = declaringType({ module, type }, leaf, std, own);
      return declaring ? `${declaring.module}.${declaring.type}.${leaf}` : undefined;
    },
  };
}

/** Leftmost identifier of a `field_access` chain (`System.out` → `System`). */
function leftmostIdentifier(node: Node): string {
  let current: Node | null = node;
  while (current?.type === 'field_access') current = current.childForFieldName('object');
  return current?.type === 'identifier' ? current.text : '';
}

function resolveInvocation(
  node: Node,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: JavaIndexes,
): Resolved {
  const method = fieldText(node, 'name');
  if (!method) return unresolvedOf(node.text);
  const self: TypeRef = { module: scan.moduleId, type: context.className };
  const inherited = (): Resolved | undefined => {
    const ancestor = declaringType(self, method, std, own, { skipSelf: true });
    return ancestor
      ? { calleeId: `${ancestor.module}.${ancestor.type}.${method}`, callType: 'self_method' }
      : undefined;
  };

  const object = node.childForFieldName('object');

  // A. bare `m(...)` — own class, an ancestor, or a static import.
  if (!object) {
    return (
      resolveOwnMethod(context.className, method, scan, std) ??
      inherited() ??
      resolveViaImport(method, scan, std, importOptions(std, own)) ??
      unresolvedOf(method)
    );
  }

  // B. `this.m(...)`
  if (object.type === 'this') {
    return (
      resolveOwnMethod(context.className, method, scan, std) ??
      inherited() ??
      unresolvedOf(`this.${method}`)
    );
  }

  // C. `super.m(...)` — never the class's own declaration.
  if (object.type === 'super') {
    return inherited() ?? unresolvedOf(`super.${method}`);
  }

  if (object.type === 'field_access') {
    // D. `this.field.m(...)` through the field's declared type.
    if (object.childForFieldName('object')?.type === 'this') {
      const field = fieldText(object, 'field');
      const type = fieldTypeOf(context.className, field, scan, own);
      if (type) return resolveOnType(type, method, 'self_attr_method', scan, std, own);
      return unresolvedOf(`this.${field}.${method}`);
    }
    // E. `Outer.Inner.m(...)` / `com.demo.Engine.m(...)` — a qualified type.
    const last = fieldText(object, 'field');
    if (last && moduleOfType(last, scan, own)) {
      return resolveOnType(last, method, 'internal_func', scan, std, own);
    }
    // `System.out.println(...)` — a chain rooted at a type leaves the scan set.
    const head = leftmostIdentifier(object);
    if (head && (scan.imports.has(head) || /^[A-Z]/.test(head))) {
      return boundaryOf(object.text, method);
    }
    return unresolvedOf(`${object.text}.${method}`);
  }

  // F. `base.m(...)` where base is one bare name.
  if (object.type === 'identifier') {
    const base = object.text;
    const localType = context.types.get(base);
    if (localType) return resolveOnType(localType, method, 'param_method', scan, std, own);
    // A field referenced without `this.` is still a field access.
    const fieldType = fieldTypeOf(context.className, base, scan, own);
    if (fieldType) return resolveOnType(fieldType, method, 'self_attr_method', scan, std, own);
    if (moduleOfType(base, scan, own)) {
      return resolveOnType(base, method, 'internal_func', scan, std, own);
    }
    const imported = scan.imports.get(base);
    if (imported) return boundaryOf(imported, method);
    // `java.lang` is imported implicitly, so an unimported capitalized qualifier
    // is almost always a type — one outside the scan set, which is what
    // `boundary` states. Lowercase names stay unresolved: they are untyped
    // values, and claiming they leave the scan set would be a guess.
    if (/^[A-Z]/.test(base)) return boundaryOf(base, method);
    return unresolvedOf(`${base}.${method}`);
  }

  return unresolvedOf(`${object.text}.${method}`);
}

function resolveNew(node: Node, scan: ModuleScan, own: JavaIndexes): Resolved {
  const type = bareTypeName(node.childForFieldName('type'));
  if (!type) return unresolvedOf(node.text);
  const module = moduleOfType(type, scan, own);
  // A Java constructor is named after its class, hence the doubled last segment.
  if (module) {
    return { calleeId: `${module}.${type}.${type}`, callType: 'internal_constructor' };
  }
  return boundaryOf(scan.imports.get(type) ?? type, undefined, { isConstructor: true });
}

/** `this(...)` / `super(...)` at the head of a constructor body. */
function resolveExplicitConstructor(
  node: Node,
  scan: ModuleScan,
  context: FnContext,
  own: JavaIndexes,
): Resolved {
  const kind = node.childForFieldName('constructor')?.type;
  if (kind === 'this') {
    return {
      calleeId: `${scan.moduleId}.${context.className}.${context.className}`,
      callType: 'internal_constructor',
    };
  }
  if (kind === 'super') {
    const parent = scan.superclassName.get(context.className);
    // No `extends` means the superclass is `java.lang.Object`.
    if (!parent) return boundaryOf('Object', undefined, { isConstructor: true });
    const module = moduleOfType(parent, scan, own);
    if (module) {
      return { calleeId: `${module}.${parent}.${parent}`, callType: 'internal_constructor' };
    }
    return boundaryOf(scan.imports.get(parent) ?? parent, undefined, { isConstructor: true });
  }
  return unresolvedOf(node.text);
}

/** Source text of a call site, collapsed to one line. */
function rawOf(text: string): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), 80);
}

const CAPABILITIES: AdapterCapabilities = {
  tier: 'full',
  callTypes: [
    'self_method',
    'self_attr_method',
    'param_method',
    'internal_func',
    'internal_constructor',
    'boundary',
    'boundary_constructor',
    'unresolved',
  ],
  selfAttrs: true,
  statementSpans: false,
};

const JAVA_SPEC: LanguageSpec<ModuleScan, JavaIndexes> = {
  name: 'java',
  extensions: ['.java'],
  grammarFor: () => 'java',
  extraSkipDirs: EXTRA_SKIP_DIRS,
  // Path-derived, like every other adapter: `package` is Java's semantic module,
  // but a path keeps ids unique even when two files declare the same package.
  // In a conventional tree (directory == package) the two agree anyway, so an id
  // reads as the type's fully qualified name.
  moduleIdForFile,
  capabilities: CAPABILITIES,

  emptyScan(moduleId) {
    return {
      moduleId,
      files: [],
      functions: [],
      fnContext: new Map(),
      imports: new Map(),
      ownerMethods: new Map(),
      fieldTypes: new Map(),
      freeFunctions: new Set(),
      packageName: '',
      supertypeNames: new Map(),
      superclassName: new Map(),
      wildcardPackages: [],
    };
  },

  scan(scan, root, file) {
    for (const child of root.namedChildren) {
      if (!child) continue;
      if (child.type === 'package_declaration') {
        const name = child.namedChildren.find((c) => c !== null);
        if (name) scan.packageName = name.text;
      } else if (child.type === 'import_declaration') {
        collectImport(child, scan);
      } else if (TYPE_DECLARATIONS.has(child.type)) {
        scanTypeDeclaration(scan, child, file);
      }
    }
    // Java overloads (`m()` and `m(int)`) share `<module>.<Type>.m`; ids must be
    // unique, so keep the last and do not multiply its pass-2 edges.
    scan.functions = dedupeFunctionsById(scan.functions);
  },

  buildIndexes,

  extractCalls(scan, std, own) {
    const edges: CallEdge[] = [];
    for (const fn of scan.functions) {
      const context = scan.fnContext.get(fn.id);
      if (!context) continue;
      walk(context.body, (node) => {
        if (NESTED_SCOPES.has(node.type)) return false;
        let resolved: Resolved | undefined;
        let raw = '';
        if (node.type === 'method_invocation') {
          resolved = resolveInvocation(node, scan, context, std, own);
          const object = node.childForFieldName('object');
          const method = fieldText(node, 'name');
          raw = object ? `${object.text}.${method}` : method;
        } else if (node.type === 'object_creation_expression') {
          resolved = resolveNew(node, scan, own);
          raw = node.text;
        } else if (node.type === 'explicit_constructor_invocation') {
          resolved = resolveExplicitConstructor(node, scan, context, own);
          raw = `${fieldText(node, 'constructor')}${fieldText(node, 'arguments')}`;
        }
        if (!resolved) return undefined;
        edges.push({
          callerId: fn.id,
          calleeId: resolved.calleeId,
          isAwait: false,
          callType: resolved.callType,
          line: lineStart(node),
          raw: rawOf(raw),
        });
        return undefined;
      });
    }
    return edges;
  },
};

export class JavaAdapter extends SpineAdapter<ModuleScan, JavaIndexes> {
  constructor() {
    super(JAVA_SPEC);
  }
}
