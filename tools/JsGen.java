import com.sun.tools.javac.code.*;
import com.sun.tools.javac.code.Symbol.*;
import com.sun.tools.javac.code.Type.*;
import com.sun.tools.javac.tree.JCTree;
import com.sun.tools.javac.tree.JCTree.*;
import com.sun.tools.javac.tree.TreeInfo;
import com.sun.tools.javac.util.Context;
import com.sun.tools.javac.util.Name;

import java.util.*;

/** JavaScript back end. Emits one ES2020 class per translated Java class. See docs in NAMING below. */
class JsGen {
    /*
     * NAMING (shared contract with the hand-written runtime in port/runtime/*.js)
     *   class      : flatname with '.' -> '_'                    d_bwm, android_graphics_Canvas, dk_..._Game$Difficulty
     *   method     : name + '$' + erased param sigs joined '$'    a$F$F, drawBitmap$Bitmap$F$F$Paint, toString$
     *                (signature taken from the *root* method the method overrides, so overrides agree)
     *   ctor       : $init$ + sigs, an instance method returning this;  new X().$init$I(5)
     *   static fld : S$name  (on the class)        instance fld: name (or name$Owner when it hides a super field)
     *   sigs       : I J F D Z B S C primitives, AI = int[], other = simple flat class name (Bitmap, Bitmap$Config)
     *   long       : BigInt          float: Math.fround'ed double       char/short/byte: int
     */
    final Model model;
    final Set<ClassSymbol> reach;
    final Types types;
    final Symtab syms;
    final Context ctx;
    int emittedCount = 0;

    final Set<String> externalUse = new TreeSet<>();
    final Map<MethodSymbol, MethodSymbol> rootCache = new HashMap<>();
    final Map<ClassSymbol, Boolean> clinitCache = new HashMap<>();

    JsGen(Model model, Set<ClassSymbol> reach, Context ctx) {
        this.model = model; this.reach = reach; this.ctx = ctx;
        this.types = Types.instance(ctx);
        this.syms = Symtab.instance(ctx);
    }

    // ---------------------------------------------------------------- naming
    static final Set<String> JS_RESERVED = new HashSet<>(Arrays.asList(
        "function", "var", "let", "const", "in", "of", "delete", "typeof", "with", "yield", "await", "arguments", "eval",
        "undefined", "NaN", "Infinity", "export", "debugger", "null", "true", "false", "async", "static", "implements",
        "interface", "package", "private", "protected", "public", "new", "this", "super", "class", "enum", "extends",
        "import", "void", "instanceof", "constructor", "prototype", "Math", "Object", "Array", "String", "Number", "BigInt",
        "Symbol", "Map", "Set", "Date", "JSON", "Error", "Function", "Boolean", "window", "document", "console", "name", "length"));

    String safeId(String n) {
        if (JS_RESERVED.contains(n) || n.startsWith("$") || n.startsWith("java_") || n.startsWith("android_") || n.startsWith("d_") || n.startsWith("dk_")) return n + "$";
        return n;
    }

    String jsClass(ClassSymbol c) { return c.flatname.toString().replace('.', '_'); }

    String simpleFlat(ClassSymbol c) {
        String f = c.flatname.toString();
        int i = f.lastIndexOf('.');
        return i < 0 ? f : f.substring(i + 1);
    }

    String sigOf(Type t) {
        t = types.erasure(t);
        switch (t.getTag()) {
            case INT: return "I"; case LONG: return "J"; case FLOAT: return "F"; case DOUBLE: return "D";
            case BOOLEAN: return "Z"; case BYTE: return "B"; case SHORT: return "S"; case CHAR: return "C";
            case ARRAY: return "A" + sigOf(((ArrayType) t).elemtype);
            case CLASS: return simpleFlat((ClassSymbol) t.tsym);
            default: return "Object";
        }
    }

    String paramSigs(List<Type> ps) {
        StringBuilder sb = new StringBuilder();
        for (Type p : ps) sb.append('$').append(sigOf(p));
        return sb.toString();
    }

    MethodSymbol rootOf(MethodSymbol m) {
        MethodSymbol cached = rootCache.get(m);
        if (cached != null) return cached;
        MethodSymbol result = m;
        if (!m.isConstructor() && !m.isStatic() && m.owner instanceof ClassSymbol) {
            ClassSymbol owner = (ClassSymbol) m.owner;
            outer:
            for (Type st : types.closure(owner.type)) {
                if (st.tsym == owner) continue;
                if (!(st.tsym instanceof ClassSymbol)) continue;
                for (Symbol s : st.tsym.members().getSymbolsByName(m.name)) {
                    if (s instanceof MethodSymbol && !s.isStatic() && m.overrides(s, owner, types, false)) {
                        result = rootOf((MethodSymbol) s);
                        break outer;
                    }
                }
            }
        }
        rootCache.put(m, result);
        return result;
    }

    private final Map<MethodSymbol, String> mnameCache = new HashMap<>();
    int mnameRenamed = 0;

    String plainName(MethodSymbol r) {
        return r.name.toString() + "$" + joinSigs(types.erasure(r.type).getParameterTypes());
    }

    /**
     * Java lets unrelated methods share a name+signature inside one class hierarchy (private methods, package-private methods
     * of different packages - ProGuard reuses names like a() heavily). JS has one namespace per prototype chain, so such a
     * method would silently override / be overridden. A method family whose name is also used by a NON-overriding method of a
     * related class gets the suffix "$$<Owner>".
     */
    boolean hasNameClash(MethodSymbol r, String n) {
        ClassSymbol owner = (ClassSymbol) r.owner;
        for (ClassSymbol c : reach) {
            if (c != owner && !(c.isSubClass(owner, types) || owner.isSubClass(c, types))) continue;
            for (Symbol s : c.members().getSymbolsByName(r.name)) {
                if (!(s instanceof MethodSymbol) || s.isStatic() || s == r || ((MethodSymbol) s).isConstructor()) continue;
                MethodSymbol sr = rootOf((MethodSymbol) s);
                if (sr == r) continue;
                if (plainName(sr).equals(n)) return true;
            }
        }
        return false;
    }

    String mname(MethodSymbol m) {
        if (m.isConstructor()) return "$init$" + joinSigs(m.type.getParameterTypes());
        MethodSymbol r = rootOf(m);
        String cached = mnameCache.get(r);
        if (cached != null) return cached;
        String n = plainName(r);
        if (!r.isStatic() && r.owner instanceof ClassSymbol && model.isTranslated((ClassSymbol) r.owner) && hasNameClash(r, n)) {
            n = n + "$$" + simpleFlat((ClassSymbol) r.owner);
            mnameRenamed++;
        }
        mnameCache.put(r, n);
        return n;
    }

    /** "I$J" style join (no leading separator) */
    String joinSigs(List<Type> ps) {
        String s = paramSigs(ps);
        return s.isEmpty() ? "" : s.substring(1);
    }

    String fname(VarSymbol f) {
        String n = f.name.toString();
        if (f.isStatic()) return "S$" + n;
        if (n.equals("constructor") || n.equals("__proto__") || n.startsWith("$")) n = "F$" + n;
        if (f.owner instanceof ClassSymbol) {
            ClassSymbol c = (ClassSymbol) f.owner;
            Type sup = types.supertype(c.type);
            while (sup != null && sup.tsym instanceof ClassSymbol) {
                for (Symbol s : sup.tsym.members().getSymbolsByName(f.name)) {
                    if (s instanceof VarSymbol && !s.isStatic()) return n + "$$" + simpleFlat(c);
                }
                sup = types.supertype(sup);
            }
        }
        return n;
    }

    // ---------------------------------------------------------------- type kinds
    enum K { BOOL, BYTE, SHORT, CHAR, INT, LONG, FLOAT, DOUBLE, REF, VOID }

    K kindOf(Type t) {
        if (t == null) return K.REF;
        switch (t.getTag()) {
            case BOOLEAN: return K.BOOL; case BYTE: return K.BYTE; case SHORT: return K.SHORT; case CHAR: return K.CHAR;
            case INT: return K.INT; case LONG: return K.LONG; case FLOAT: return K.FLOAT; case DOUBLE: return K.DOUBLE;
            case VOID: return K.VOID;
            default: return K.REF;
        }
    }

    K valueKind(Type t) {
        if (t == null) return K.REF;
        if (t.getTag() == TypeTag.CLASS) {
            Type u = types.unboxedType(t);
            if (u != null && u.getTag() != TypeTag.NONE) return kindOf(u);
            return K.REF;
        }
        return kindOf(t);
    }

    boolean intLike(K k) { return k == K.BYTE || k == K.SHORT || k == K.CHAR || k == K.INT; }

    boolean isString(Type t) { return t != null && t.getTag() == TypeTag.CLASS && t.tsym.getQualifiedName().contentEquals("java.lang.String"); }

    boolean isBoxedOrString(Type t) {
        if (t == null || t.getTag() != TypeTag.CLASS) return false;
        String q = ((ClassSymbol) types.erasure(t).tsym).getQualifiedName().toString();
        switch (q) {
            case "java.lang.String": case "java.lang.CharSequence": case "java.lang.Integer": case "java.lang.Long": case "java.lang.Short":
            case "java.lang.Byte": case "java.lang.Float": case "java.lang.Double": case "java.lang.Boolean": case "java.lang.Character":
            case "java.lang.Number": return true;
            default: return false;
        }
    }

    /** diagnostic: an int/int division whose result is silently widened to float/double (JADX drops the (float) cast) */
    String convE(JCExpression e, Type to) {
        K t = valueKind(to);
        if (t == K.FLOAT || t == K.DOUBLE) {
            JCExpression x = e;
            while (x instanceof JCParens) x = ((JCParens) x).expr;
            if (x instanceof JCBinary && ((JCBinary) x).getTag() == Tag.DIV) {
                K k = valueKind(x.type);
                if (k == K.INT || k == K.LONG) System.err.println("INTDIV-REVIEW " + fn.cls.flatname + ": " + e.toString().replace('\n', ' ') + "  -> " + to);
            }
        }
        return conv(expr(e), e.type, to);
    }

    String conv(String js, Type from, Type to) {
        K f = valueKind(from), t = valueKind(to);
        if (f == K.REF || t == K.REF || f == K.VOID || t == K.VOID || f == t) return js;
        if (t == K.BOOL || f == K.BOOL) return js;
        switch (t) {
            case LONG:
                if (intLike(f)) return "BigInt(" + js + ")";
                return "$d2l(" + js + ")";
            case FLOAT:
                if (intLike(f) || f == K.DOUBLE) return "Math.fround(" + js + ")";
                if (f == K.LONG) return "Math.fround(Number(" + js + "))";
                return js;
            case DOUBLE:
                if (f == K.LONG) return "Number(" + js + ")";
                return js;
            case INT: {
                if (f == K.LONG) return "$l2i(" + js + ")";
                if (f == K.FLOAT || f == K.DOUBLE) return "$d2i(" + js + ")";
                return js;
            }
            case SHORT: {
                String i = convInt(js, f);
                if (f == K.BYTE) return js;
                return "(" + i + " << 16 >> 16)";
            }
            case BYTE: return "(" + convInt(js, f) + " << 24 >> 24)";
            case CHAR: return "(" + convInt(js, f) + " & 65535)";
            default: return js;
        }
    }

    String convInt(String js, K f) {
        if (f == K.LONG) return "$l2i(" + js + ")";
        if (f == K.FLOAT || f == K.DOUBLE) return "$d2i(" + js + ")";
        return js;
    }

    String defaultValue(Type t) {
        switch (kindOf(t)) {
            case BOOL: return "false"; case LONG: return "0n";
            case BYTE: case SHORT: case CHAR: case INT: case FLOAT: case DOUBLE: return "0";
            default: return "null";
        }
    }

    // ---------------------------------------------------------------- constants & literals
    String jsString(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 32 || c > 126) sb.append(String.format("\\u%04x", (int) c)); else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    String fmtDouble(double d) {
        if (Double.isNaN(d)) return "NaN";
        if (Double.isInfinite(d)) return d > 0 ? "Infinity" : "(-Infinity)";
        if (d == 0 && 1 / d < 0) return "(-0)";
        String s = Double.toString(d);
        return d < 0 ? "(" + s + ")" : s;
    }

    String constLit(Type t, Object v) {
        switch (t.getTag()) {
            case BOOLEAN: return ((Number) v).intValue() != 0 ? "true" : "false";
            case CHAR: case BYTE: case SHORT: case INT: { int i = ((Number) v).intValue(); return i < 0 ? "(" + i + ")" : "" + i; }
            case LONG: { long l = ((Number) v).longValue(); return l < 0 ? "(" + l + "n)" : l + "n"; }
            case FLOAT: return fmtDouble((double) ((Number) v).floatValue());
            case DOUBLE: return fmtDouble(((Number) v).doubleValue());
            default:
                if (v instanceof String) return jsString((String) v);
                return null;
        }
    }

    String constOf(JCExpression e) {
        if (e.type == null) return null;
        Object v = e.type.constValue();
        if (v == null) return null;
        if (!(e instanceof JCLiteral || e instanceof JCIdent || e instanceof JCFieldAccess || e instanceof JCBinary
                || e instanceof JCUnary || e instanceof JCTypeCast || e instanceof JCConditional || e instanceof JCParens)) return null;
        if (e instanceof JCUnary) {
            Tag t = e.getTag();
            if (t == Tag.PREINC || t == Tag.PREDEC || t == Tag.POSTINC || t == Tag.POSTDEC) return null;
        }
        return constLit(e.type, v);
    }

    // ---------------------------------------------------------------- class level info
    boolean isEnum(ClassSymbol c) { return (c.flags() & Flags.ENUM) != 0; }
    boolean isInterface(ClassSymbol c) { return (c.flags() & Flags.INTERFACE) != 0; }

    boolean needsClinit(ClassSymbol c) {
        Boolean b = clinitCache.get(c);
        if (b != null) return b;
        boolean r = false;
        JCClassDecl d = model.decls.get(c);
        if (d != null && !model.isStubFile(d)) {
            if (isEnum(c)) r = true;
            for (JCTree m : d.defs) {
                if (m instanceof JCBlock && (((JCBlock) m).flags & Flags.STATIC) != 0) r = true;
                if (m instanceof JCVariableDecl) {
                    JCVariableDecl v = (JCVariableDecl) m;
                    if ((v.mods.flags & Flags.STATIC) != 0 && v.init != null) {
                        Object cv = v.sym.getConstValue();
                        if (cv == null) r = true;
                    }
                }
            }
        }
        clinitCache.put(c, r);
        return r;
    }

    /** reference to a class used for static member access; triggers lazy initialisation when required */
    String sref(ClassSymbol c, ClassSymbol from) {
        String n = jsClass(c);
        if (!model.isTranslated(c)) { noteExternal(c, null); return n; }
        if (!needsClinit(c)) return n;
        if (from != null && isSubClassOrSame(from, c)) return n;
        return "(" + n + ".$ci?" + n + ":" + n + ".$clinit())";
    }

    boolean isSubClassOrSame(ClassSymbol a, ClassSymbol b) {
        return a == b || a.isSubClass(b, types);
    }

    void noteExternal(Symbol s, String what) {
        ClassSymbol c = s instanceof ClassSymbol ? (ClassSymbol) s : s.enclClass();
        if (c == null) return;
        String cn = jsClass(c);
        externalUse.add(what == null ? "class " + cn : "  " + cn + "." + what);
    }

    String externalReport() {
        StringBuilder sb = new StringBuilder();
        String lastClass = "";
        // group: lines starting with "class X" followed by their members
        TreeMap<String, TreeSet<String>> byClass = new TreeMap<>();
        for (String s : externalUse) {
            if (s.startsWith("class ")) byClass.computeIfAbsent(s.substring(6), k -> new TreeSet<>());
            else {
                String t = s.trim();
                int dot = t.indexOf('.');
                // class names contain '_' and '$' but the member separator is the first '.' we added
                String cn = t.substring(0, dot);
                byClass.computeIfAbsent(cn, k -> new TreeSet<>()).add(t.substring(dot + 1));
            }
        }
        for (Map.Entry<String, TreeSet<String>> e : byClass.entrySet()) {
            sb.append(e.getKey()).append('\n');
            for (String m : e.getValue()) sb.append("    ").append(m).append('\n');
        }
        return sb.toString();
    }

    // ---------------------------------------------------------------- driver
    String generate() {
        Runtime.getRuntime().addShutdownHook(new Thread(() -> System.err.println("renamed clashing methods: " + mnameRenamed)));
        List<ClassSymbol> classes = new ArrayList<>();
        for (ClassSymbol c : model.decls.keySet()) if (reach.contains(c) && model.isTranslated(c)) classes.add(c);
        // topological order on superclass
        List<ClassSymbol> ordered = new ArrayList<>();
        Set<ClassSymbol> done = new HashSet<>();
        for (ClassSymbol c : classes) order(c, classes, ordered, done);
        StringBuilder out = new StringBuilder();
        out.append("// GENERATED by tools/Transpiler.java from the decompiled Air Attack sources. Do not edit by hand.\n");
        out.append("\"use strict\";\n");
        for (ClassSymbol c : ordered) {
            try {
                out.append(genClass(model.decls.get(c)));
            } catch (RuntimeException ex) {
                System.err.println("while generating " + c.flatname + ": " + ex);
                throw ex;
            }
            emittedCount++;
        }
        return out.toString();
    }

    void order(ClassSymbol c, List<ClassSymbol> all, List<ClassSymbol> out, Set<ClassSymbol> done) {
        if (!done.add(c)) return;
        Type sup = c.getSuperclass();
        if (sup != null && sup.tsym instanceof ClassSymbol && all.contains(sup.tsym)) order((ClassSymbol) sup.tsym, all, out, done);
        out.add(c);
    }

    // ---------------------------------------------------------------- per-function context
    class Fn {
        ClassSymbol cls;
        boolean isStatic;
        Type retType;
        int tmpCount = 0;
        int indent = 1;
        StringBuilder sb = new StringBuilder();
        Fn(ClassSymbol cls, boolean isStatic, Type ret) { this.cls = cls; this.isStatic = isStatic; this.retType = ret; }
        String tmp() { return "$t" + (tmpCount++); }
    }

    Fn fn; // current function context

    String genClass(JCClassDecl cd) {
        return genClassExpr(cd, "class " + jsClass(cd.sym), true);
    }

    /** emits `<head> extends X { ... }` plus (for named top-level classes) the static trailer. */
    String genClassExpr(JCClassDecl cd, String head, boolean named) {
        ClassSymbol cs = cd.sym;
        boolean anon = !named;
        StringBuilder sb = new StringBuilder();
        Type sup = cs.getSuperclass();
        String superJs = "java_lang_Object";
        if (isInterface(cs)) superJs = "java_lang_Object";
        else if (sup != null && sup.tsym instanceof ClassSymbol) {
            ClassSymbol sc = (ClassSymbol) sup.tsym;
            superJs = jsClass(sc);
            if (!model.isTranslated(sc)) noteExternal(sc, null);
        }
        if (isEnum(cs)) superJs = "java_lang_Enum";
        sb.append(head).append(" extends ").append(superJs).append(" {\n");

        // constructor: default values of own instance fields
        sb.append("  constructor() { super();");
        boolean clinit = needsClinit(cs);
        if (clinit && !anon) sb.append(" if (!").append(jsClass(cs)).append(".$ci) ").append(jsClass(cs)).append(".$clinit();");
        for (JCTree m : cd.defs) {
            if (m instanceof JCVariableDecl) {
                JCVariableDecl v = (JCVariableDecl) m;
                if ((v.mods.flags & Flags.STATIC) == 0) sb.append(" this.").append(fname(v.sym)).append(" = ").append(defaultValue(v.sym.type)).append(';');
            }
        }
        sb.append(" }\n");

        // field initialisers + instance init blocks
        List<JCTree> finit = new ArrayList<>();
        for (JCTree m : cd.defs) {
            if (m instanceof JCVariableDecl) {
                JCVariableDecl v = (JCVariableDecl) m;
                if ((v.mods.flags & Flags.STATIC) == 0 && v.init != null) finit.add(m);
            } else if (m instanceof JCBlock && (((JCBlock) m).flags & Flags.STATIC) == 0) finit.add(m);
        }
        String finitName = "$finit$" + simpleFlat(cs).replace('$', '_');
        if (!finit.isEmpty()) {
            Fn saved = fn;
            fn = new Fn(cs, false, null);
            for (JCTree m : finit) {
                if (m instanceof JCVariableDecl) {
                    JCVariableDecl v = (JCVariableDecl) m;
                    line("this." + fname(v.sym) + " = " + convE(v.init, v.sym.type) + ";");
                } else {
                    stmt(m);
                }
            }
            sb.append("  ").append(finitName).append("() {\n").append(fnBody()).append("  }\n");
            fn = saved;
        }

        // methods
        boolean hasCtor = false;
        for (JCTree m : cd.defs) {
            if (!(m instanceof JCMethodDecl)) continue;
            JCMethodDecl md = (JCMethodDecl) m;
            if (md.sym.isConstructor()) hasCtor = true;
            sb.append(genMethod(cd, md, !finit.isEmpty() ? finitName : null));
        }
        if (!hasCtor && !isInterface(cs)) {
            sb.append("  $init$() { super.$init$(); ").append(!finit.isEmpty() ? "this." + finitName + "(); " : "").append("return this; }\n");
        }

        // enum helpers
        if (isEnum(cs)) {
            String n = jsClass(cs);
            sb.append("  static values$() { ").append(n).append(".$ci || ").append(n).append(".$clinit(); return ").append(n).append(".$VALUES.slice(); }\n");
            sb.append("  static valueOf$String(s) { ").append(n).append(".$ci || ").append(n).append(".$clinit(); return java_lang_Enum.$valueOf(").append(n).append(".$VALUES, s); }\n");
        }

        // static init
        if (clinit) {
            Fn saved = fn;
            fn = new Fn(cs, true, null);
            String n = jsClass(cs);
            line(n + ".$ci = true;");
            Type sc = cs.getSuperclass();
            if (sc != null && sc.tsym instanceof ClassSymbol && model.isTranslated((ClassSymbol) sc.tsym) && needsClinit((ClassSymbol) sc.tsym)) {
                String sn = jsClass((ClassSymbol) sc.tsym);
                line("if (!" + sn + ".$ci) " + sn + ".$clinit();");
            }
            int ord = 0;
            List<String> enumNames = new ArrayList<>();
            for (JCTree m : cd.defs) {
                if (m instanceof JCVariableDecl) {
                    JCVariableDecl v = (JCVariableDecl) m;
                    if ((v.mods.flags & Flags.ENUM) != 0) {
                        enumNames.add(n + "." + fname(v.sym));
                        line(n + "." + fname(v.sym) + " = " + genEnumConstant(cs, v, ord++) + ";");
                    }
                }
            }
            if (isEnum(cs)) line(n + ".$VALUES = [" + String.join(", ", enumNames) + "];");
            for (JCTree m : cd.defs) {
                if (m instanceof JCVariableDecl) {
                    JCVariableDecl v = (JCVariableDecl) m;
                    if ((v.mods.flags & Flags.STATIC) != 0 && (v.mods.flags & Flags.ENUM) == 0 && v.init != null && v.sym.getConstValue() == null)
                        line(n + "." + fname(v.sym) + " = " + convE(v.init, v.sym.type) + ";");
                } else if (m instanceof JCBlock && (((JCBlock) m).flags & Flags.STATIC) != 0) {
                    stmt(m);
                }
            }
            line("return " + n + ";");
            sb.append("  static $clinit() {\n").append(fnBody()).append("  }\n");
            fn = saved;
        }

        sb.append("}\n");
        if (anon) return sb.toString();

        // trailer: statics defaults, interface table, name
        String n = jsClass(cs);
        StringBuilder tr = new StringBuilder();
        for (JCTree m : cd.defs) {
            if (m instanceof JCVariableDecl) {
                JCVariableDecl v = (JCVariableDecl) m;
                if ((v.mods.flags & Flags.STATIC) != 0) {
                    Object cv = v.sym.getConstValue();
                    String init = cv != null ? constLit(v.sym.type, cv) : defaultValue(v.sym.type);
                    tr.append(n).append('.').append(fname(v.sym)).append(" = ").append(init).append(";\n");
                }
            }
        }
        if (clinit) tr.append(n).append(".$ci = false;\n");
        tr.append(n).append(".$jname = ").append(jsString(cs.flatname.toString())).append(";\n");
        Set<String> ifs = new LinkedHashSet<>();
        collectInterfaces(cs, ifs);
        if (!ifs.isEmpty()) {
            tr.append(n).append(".$ifaces = [");
            boolean first = true;
            for (String i : ifs) { if (!first) tr.append(", "); first = false; tr.append(jsString(i)); }
            tr.append("];\n");
        }
        if (isInterface(cs)) tr.append(n).append(".$isIface = true;\n");
        return sb.toString() + tr;
    }

    void collectInterfaces(ClassSymbol c, Set<String> out) {
        for (Type i : c.getInterfaces()) {
            if (i.tsym instanceof ClassSymbol) {
                out.add(jsClass((ClassSymbol) i.tsym));
                collectInterfaces((ClassSymbol) i.tsym, out);
                if (!model.isTranslated((ClassSymbol) i.tsym)) noteExternal(i.tsym, null);
            }
        }
    }

    String genEnumConstant(ClassSymbol enumCls, JCVariableDecl v, int ord) {
        JCNewClass nc = (JCNewClass) v.init;
        StringBuilder args = new StringBuilder(jsString(v.name.toString()) + ", " + ord);
        MethodSymbol ctor = (MethodSymbol) nc.constructor;
        args.append(callArgs(nc.args, ctor, nc.varargsElement, true));
        if (nc.def != null) {
            String cls = genClassExpr(nc.def, "class", false);
            return "new (" + cls + ")()." + mname(ctor) + "(" + args + ")";
        }
        return "new " + jsClass(enumCls) + "()." + mname(ctor) + "(" + args + ")";
    }

    // ---------------------------------------------------------------- methods
    String genMethod(JCClassDecl cd, JCMethodDecl md, String finitName) {
        MethodSymbol ms = md.sym;
        if (md.body == null) return "";
        ClassSymbol cs = cd.sym;
        boolean isCtor = ms.isConstructor();
        boolean stat = ms.isStatic();
        Fn saved = fn;
        fn = new Fn(cs, stat, ms.getReturnType());
        StringBuilder params = new StringBuilder();
        if (isCtor && isEnum(cs)) params.append("$name, $ordinal");
        for (JCVariableDecl p : md.params) {
            if (params.length() > 0) params.append(", ");
            params.append(safeId(p.name.toString()));
        }
        String name = mname(ms);
        if (!isCtor && ms.isStatic() == false) { /* instance */ }
        List<JCStatement> stats = md.body.stats;
        if (isCtor) {
            boolean enumCls = isEnum(cs);
            JCStatement first = stats.isEmpty() ? null : stats.get(0);
            boolean explicitCall = false, callsThis = false;
            String callJs = null;
            if (first instanceof JCExpressionStatement && ((JCExpressionStatement) first).expr instanceof JCMethodInvocation) {
                JCMethodInvocation mi = (JCMethodInvocation) ((JCExpressionStatement) first).expr;
                Name n = TreeInfo.name(mi.meth);
                if (n != null && (n.contentEquals("this") || n.contentEquals("super"))) {
                    explicitCall = true;
                    callsThis = n.contentEquals("this");
                    Symbol tsym = TreeInfo.symbol(mi.meth);
                    if (!(tsym instanceof MethodSymbol)) throw new RuntimeException("unresolved this/super call in " + cs.flatname + ": " + mi + " -> " + tsym + " (" + (tsym == null ? null : tsym.getClass().getSimpleName()) + ")");
                    MethodSymbol target = (MethodSymbol) tsym;
                    String args = callArgs(mi.args, target, mi.varargsElement, false);
                    if (enumCls) {
                        if (callsThis) callJs = "this." + mname(target) + "($name, $ordinal" + (args.isEmpty() ? "" : ", " + args.substring(2)) + ");";
                    } else {
                        callJs = (callsThis ? "this." : "super.") + mname(target) + "(" + (args.isEmpty() ? "" : args.substring(2)) + ");";
                    }
                }
            }
            if (explicitCall) {
                if (callJs != null) line(callJs);
                if (enumCls && !callsThis) line("this.$name = $name; this.$ordinal = $ordinal;");
                if (!callsThis && finitName != null) line("this." + finitName + "();");
                for (int i = 1; i < stats.size(); i++) stmt(stats.get(i));
            } else {
                if (enumCls) line("this.$name = $name; this.$ordinal = $ordinal;");
                else line("super.$init$(); /*implicit*/");
                if (finitName != null) line("this." + finitName + "();");
                for (JCStatement s : stats) stmt(s);
            }
            line("return this;");
            String body = fnBody();
            fn = saved;
            return "  " + name + "(" + params + ") {\n" + body + "  }\n";
        }
        if (stat && needsClinit(cs)) line("if (!" + jsClass(cs) + ".$ci) " + jsClass(cs) + ".$clinit();");
        for (JCStatement s : stats) stmt(s);
        String body = fnBody();
        fn = saved;
        return "  " + (stat ? "static " : "") + name + "(" + params + ") {\n" + body + "  }\n";
    }

    String fnBody() {
        String b = fn.sb.toString();
        StringBuilder pre = new StringBuilder();
        if (fn.tmpCount > 0) {
            pre.append("    let ");
            for (int i = 0; i < fn.tmpCount; i++) { if (i > 0) pre.append(", "); pre.append("$t").append(i); }
            pre.append(";\n");
        }
        return pre + b;
    }

    void line(String s) {
        for (int i = 0; i < fn.indent + 1; i++) fn.sb.append("  ");
        fn.sb.append(s).append('\n');
    }

    // ---------------------------------------------------------------- statements
    void stmt(JCTree t) { stmt(t, false); }

    void block(JCStatement s) {
        if (s instanceof JCBlock) { for (JCStatement x : ((JCBlock) s).stats) stmt(x); }
        else stmt(s);
    }

    void stmt(JCTree t, boolean inSwitchCase) {
        if (t instanceof JCBlock) {
            line("{"); fn.indent++;
            for (JCStatement s : ((JCBlock) t).stats) stmt(s);
            fn.indent--; line("}");
        } else if (t instanceof JCVariableDecl) {
            JCVariableDecl v = (JCVariableDecl) t;
            String decl = inSwitchCase ? "var " : "let ";
            String name = safeId(v.name.toString());
            if (v.init == null) line(decl + name + " = " + defaultValue(v.sym.type) + ";");
            else line(decl + name + " = " + convE(v.init, v.sym.type) + ";");
        } else if (t instanceof JCExpressionStatement) {
            line(exprStmt(((JCExpressionStatement) t).expr) + ";");
        } else if (t instanceof JCIf) {
            JCIf i = (JCIf) t;
            line("if (" + cond(i.cond) + ") {"); fn.indent++;
            block(i.thenpart); fn.indent--;
            if (i.elsepart != null) {
                line("} else {"); fn.indent++;
                block(i.elsepart); fn.indent--;
            }
            line("}");
        } else if (t instanceof JCForLoop) {
            JCForLoop f = (JCForLoop) t;
            // `for (let i = 0, j = 0; ...)`
            StringBuilder init = new StringBuilder();
            boolean allDecl = !f.init.isEmpty();
            for (JCStatement s : f.init) if (!(s instanceof JCVariableDecl)) allDecl = false;
            if (allDecl) {
                init.append("let ");
                boolean first = true;
                for (JCStatement s : f.init) {
                    JCVariableDecl v = (JCVariableDecl) s;
                    if (!first) init.append(", ");
                    first = false;
                    init.append(safeId(v.name.toString()));
                    if (v.init != null) init.append(" = ").append(convE(v.init, v.sym.type));
                }
            } else {
                boolean first = true;
                for (JCStatement s : f.init) {
                    if (!first) init.append(", ");
                    first = false;
                    if (s instanceof JCExpressionStatement) init.append(exprStmt(((JCExpressionStatement) s).expr));
                    else if (s instanceof JCVariableDecl) { /* mixed: unsupported, rare */ throw new RuntimeException("mixed for-init"); }
                }
            }
            StringBuilder step = new StringBuilder();
            boolean first = true;
            for (JCExpressionStatement s : f.step) {
                if (!first) step.append(", ");
                first = false;
                step.append(exprStmt(s.expr));
            }
            line("for (" + init + "; " + (f.cond == null ? "" : cond(f.cond)) + "; " + step + ") {"); fn.indent++;
            block(f.body); fn.indent--; line("}");
        } else if (t instanceof JCEnhancedForLoop) {
            JCEnhancedForLoop f = (JCEnhancedForLoop) t;
            String name = safeId(f.var.name.toString());
            Type et = f.expr.type;
            if (et.getTag() == TypeTag.ARRAY) {
                String a = fn.tmp(), i = fn.tmp();
                Type elem = ((ArrayType) et).elemtype;
                line("for (" + a + " = " + expr(f.expr) + ", " + i + " = 0; " + i + " < " + a + ".length; " + i + "++) {"); fn.indent++;
                line("let " + name + " = " + conv(a + "[" + i + "]", elem, f.var.sym.type) + ";");
                block(f.body); fn.indent--; line("}");
            } else {
                String it = fn.tmp();
                line("for (" + it + " = " + expr(f.expr) + ".iterator$(); " + it + ".hasNext$(); ) {"); fn.indent++;
                line("let " + name + " = " + it + ".next$();");
                block(f.body); fn.indent--; line("}");
            }
        } else if (t instanceof JCWhileLoop) {
            JCWhileLoop w = (JCWhileLoop) t;
            line("while (" + cond(w.cond) + ") {"); fn.indent++;
            block(w.body); fn.indent--; line("}");
        } else if (t instanceof JCDoWhileLoop) {
            JCDoWhileLoop w = (JCDoWhileLoop) t;
            line("do {"); fn.indent++;
            block(w.body); fn.indent--; line("} while (" + cond(w.cond) + ");");
        } else if (t instanceof JCLabeledStatement) {
            JCLabeledStatement l = (JCLabeledStatement) t;
            line(safeId(l.label.toString()) + ":");
            stmt(l.body);
        } else if (t instanceof JCSwitch) {
            genSwitch((JCSwitch) t);
        } else if (t instanceof JCReturn) {
            JCReturn r = (JCReturn) t;
            if (r.expr == null) line("return;");
            else line("return " + convE(r.expr, fn.retType) + ";");
        } else if (t instanceof JCBreak) {
            JCBreak b = (JCBreak) t;
            line(b.label == null ? "break;" : "break " + safeId(b.label.toString()) + ";");
        } else if (t instanceof JCContinue) {
            JCContinue b = (JCContinue) t;
            line(b.label == null ? "continue;" : "continue " + safeId(b.label.toString()) + ";");
        } else if (t instanceof JCThrow) {
            line("throw " + expr(((JCThrow) t).expr) + ";");
        } else if (t instanceof JCTry) {
            genTry((JCTry) t);
        } else if (t instanceof JCSynchronized) {
            JCSynchronized s = (JCSynchronized) t;
            line("{ /*synchronized*/"); fn.indent++;
            block(s.body); fn.indent--; line("}");
        } else if (t instanceof JCSkip) {
            // nothing
        } else if (t instanceof JCAssert) {
            // assertions are disabled at runtime in Android
        } else if (t instanceof JCClassDecl) {
            JCClassDecl cd = (JCClassDecl) t;
            String n = "$L_" + cd.name.toString();
            line(genClassExpr(cd, "class " + safeId(cd.name.toString()), false).replace("\n", "\n" + "  ".repeat(fn.indent + 1)));
        } else {
            throw new RuntimeException("unsupported statement " + t.getClass().getSimpleName() + ": " + t);
        }
    }

    String cond(JCExpression e) { return expr(e); }

    void genSwitch(JCSwitch s) {
        String sel = expr(s.selector);
        Type st = s.selector.type;
        K k = valueKind(st);
        if (k == K.CHAR || k == K.BYTE || k == K.SHORT) { /* number */ }
        line("switch (" + sel + ") {"); fn.indent++;
        for (JCCase c : s.cases) {
            for (JCCaseLabel l : c.labels) {
                if (l instanceof JCConstantCaseLabel) {
                    JCExpression ce = ((JCConstantCaseLabel) l).expr;
                    line("case " + caseConst(ce) + ":");
                } else if (l instanceof JCDefaultCaseLabel) {
                    line("default:");
                } else throw new RuntimeException("unsupported case label");
            }
            fn.indent++;
            for (JCStatement x : c.stats) stmt(x, true);
            fn.indent--;
        }
        fn.indent--; line("}");
    }

    String caseConst(JCExpression ce) {
        String c = constOf(ce);
        if (c != null) return c;
        return expr(ce); // enum constant
    }

    void genTry(JCTry t) {
        if (!t.resources.isEmpty()) throw new RuntimeException("try-with-resources unsupported");
        line("try {"); fn.indent++;
        for (JCStatement s : t.body.stats) stmt(s);
        fn.indent--;
        if (!t.catchers.isEmpty()) {
            String ev = fn.tmp();
            line("} catch (" + ev + "$) {"); fn.indent++;
            line(ev + " = $jex(" + ev + "$);");
            boolean first = true;
            boolean catchAll = false;
            for (JCCatch c : t.catchers) {
                List<Type> alts = new ArrayList<>();
                if (c.param.vartype instanceof JCTypeUnion) {
                    for (JCExpression a : ((JCTypeUnion) c.param.vartype).alternatives) alts.add(a.type);
                } else alts.add(c.param.sym.type);
                StringBuilder cnd = new StringBuilder();
                for (Type a : alts) {
                    if (cnd.length() > 0) cnd.append(" || ");
                    if (a.tsym.getQualifiedName().contentEquals("java.lang.Throwable")) cnd.append("true");
                    else cnd.append(ev).append(" instanceof ").append(jsClass((ClassSymbol) a.tsym));
                    if (!model.isTranslated((ClassSymbol) a.tsym)) noteExternal(a.tsym, null);
                }
                line((first ? "" : "} else ") + "if (" + cnd + ") {"); fn.indent++;
                first = false;
                line("let " + safeId(c.param.name.toString()) + " = " + ev + ";");
                for (JCStatement s : c.body.stats) stmt(s);
                fn.indent--;
            }
            line("} else { throw " + ev + "; }");
            fn.indent--;
        }
        if (t.finalizer != null) {
            line("} finally {"); fn.indent++;
            for (JCStatement s : t.finalizer.stats) stmt(s);
            fn.indent--;
        }
        line("}");
    }

    // ---------------------------------------------------------------- expressions
    /** expression statement: prefer cheap forms for ++/-- when the value is unused. */
    String exprStmt(JCExpression e) {
        e = TreeInfo.skipParens(e);
        if (e instanceof JCUnary) {
            JCUnary u = (JCUnary) e;
            Tag tg = u.getTag();
            if (tg == Tag.POSTINC || tg == Tag.POSTDEC || tg == Tag.PREINC || tg == Tag.PREDEC) {
                boolean inc = tg == Tag.POSTINC || tg == Tag.PREINC;
                return incDec(u.arg, inc, false);
            }
        }
        return expr(e);
    }

    String expr(JCExpression e) {
        String c = constOf(e);
        if (c != null) return c;
        if (e instanceof JCParens) return "(" + expr(((JCParens) e).expr) + ")";
        if (e instanceof JCLiteral) return literal((JCLiteral) e);
        if (e instanceof JCIdent) return ident((JCIdent) e);
        if (e instanceof JCFieldAccess) return select((JCFieldAccess) e);
        if (e instanceof JCMethodInvocation) return call((JCMethodInvocation) e);
        if (e instanceof JCNewClass) return newClass((JCNewClass) e);
        if (e instanceof JCNewArray) return newArray((JCNewArray) e);
        if (e instanceof JCArrayAccess) {
            JCArrayAccess a = (JCArrayAccess) e;
            return expr(a.indexed) + "[" + conv(expr(a.index), a.index.type, syms.intType) + "]";
        }
        if (e instanceof JCBinary) return binary((JCBinary) e);
        if (e instanceof JCUnary) return unary((JCUnary) e);
        if (e instanceof JCAssign) return assign((JCAssign) e);
        if (e instanceof JCAssignOp) return assignOp((JCAssignOp) e);
        if (e instanceof JCConditional) {
            JCConditional q = (JCConditional) e;
            return "(" + expr(q.cond) + " ? " + conv(expr(q.truepart), q.truepart.type, q.type) + " : " + conv(expr(q.falsepart), q.falsepart.type, q.type) + ")";
        }
        if (e instanceof JCTypeCast) return cast((JCTypeCast) e);
        if (e instanceof JCInstanceOf) return instanceOf((JCInstanceOf) e);
        if (e instanceof JCLambda) return lambda((JCLambda) e);
        if (e instanceof JCMemberReference) return memberRef((JCMemberReference) e);
        throw new RuntimeException("unsupported expression " + e.getClass().getSimpleName() + ": " + e);
    }

    String literal(JCLiteral l) {
        switch (l.typetag) {
            case BOT: return "null";
            case BOOLEAN: return ((Number) l.value).intValue() != 0 ? "true" : "false";
            case CLASS: return jsString((String) l.value);
            default: return constLit(l.type, l.value);
        }
    }

    // outer-instance navigation ------------------------------------------------
    String outerPath(ClassSymbol from, ClassSymbol target) {
        String p = "this";
        ClassSymbol c = from;
        int guard = 0;
        while (c != null && !isSubClassOrSame(c, target)) {
            p += ".$outer";
            Symbol o = c.owner;
            c = o == null ? null : o.enclClass();
            if (++guard > 20) throw new RuntimeException("outer path overflow: " + from + " -> " + target);
        }
        if (c == null) throw new RuntimeException("no enclosing instance of " + target + " from " + from);
        return p;
    }

    String ident(JCIdent id) {
        Symbol s = id.sym;
        String n = id.name.toString();
        if (n.equals("this")) return "this";
        if (n.equals("super")) return "super";
        if (s instanceof VarSymbol) {
            VarSymbol v = (VarSymbol) s;
            if (v.owner instanceof ClassSymbol) {
                ClassSymbol oc = (ClassSymbol) v.owner;
                if (v.isStatic()) {
                    if (!model.isTranslated(oc)) noteExternal(oc, fname(v));
                    return sref(oc, fn.cls) + "." + fname(v);
                }
                return outerPath(fn.cls, oc) + "." + fname(v);
            }
            return safeId(n);
        }
        if (s instanceof ClassSymbol) {
            return sref((ClassSymbol) s, fn.cls);
        }
        throw new RuntimeException("ident " + n + " sym " + s);
    }

    String select(JCFieldAccess f) {
        Symbol s = f.sym;
        String n = f.name.toString();
        if (n.equals("class")) return classLiteral(f);
        if (n.equals("length") && f.selected.type != null && f.selected.type.getTag() == TypeTag.ARRAY) return expr(f.selected) + ".length";
        if (n.equals("this")) { // Outer.this
            ClassSymbol target = (ClassSymbol) f.selected.type.tsym;
            return outerPath(fn.cls, target);
        }
        if (s instanceof VarSymbol) {
            VarSymbol v = (VarSymbol) s;
            ClassSymbol oc = (ClassSymbol) v.owner;
            if (v.isStatic()) {
                if (!model.isTranslated(oc)) noteExternal(oc, fname(v));
                return sref(oc, fn.cls) + "." + fname(v);
            }
            String recv = expr(f.selected);
            return recv + "." + fname(v);
        }
        if (s instanceof ClassSymbol) return sref((ClassSymbol) s, fn.cls);
        if (s instanceof PackageSymbol) return "";
        throw new RuntimeException("select " + f + " sym " + s);
    }

    String classLiteral(JCFieldAccess f) {
        Type t = f.selected.type;
        if (t.isPrimitive() || t.getTag() == TypeTag.VOID) return "$prim(" + jsString(t.toString()) + ")";
        if (t.getTag() == TypeTag.ARRAY) return "$arrcls(" + jsString(sigOf(t)) + ")";
        ClassSymbol c = (ClassSymbol) t.tsym;
        if (!model.isTranslated(c)) noteExternal(c, null);
        return jsClass(c);
    }

    // calls -------------------------------------------------------------------
    /** returns ", a, b" style argument list (leading comma+space) so callers can splice prefixes. */
    String callArgs(List<JCExpression> args, MethodSymbol sym, Type varargsElem, boolean forPrefix) {
        List<Type> ps = sym.type.getParameterTypes();
        StringBuilder sb = new StringBuilder();
        int n = ps.size();
        if (varargsElem != null) {
            for (int i = 0; i < n - 1; i++) sb.append(", ").append(convE(args.get(i), ps.get(i)));
            Type elem = varargsElem;
            StringBuilder arr = new StringBuilder();
            for (int i = n - 1; i < args.size(); i++) {
                if (i > n - 1) arr.append(", ");
                arr.append(convE(args.get(i), elem));
            }
            sb.append(", ").append(arrayLiteral(elem, arr.toString()));
        } else {
            for (int i = 0; i < args.size(); i++) sb.append(", ").append(convE(args.get(i), ps.get(i)));
        }
        return sb.toString();
    }

    String arrayLiteral(Type elem, String elems) {
        switch (kindOf(types.erasure(elem))) {
            case INT: return "Int32Array.of(" + elems + ")";
            case FLOAT: return "Float32Array.of(" + elems + ")";
            case DOUBLE: return "Float64Array.of(" + elems + ")";
            case LONG: return "BigInt64Array.of(" + elems + ")";
            case BYTE: return "Int8Array.of(" + elems + ")";
            case SHORT: return "Int16Array.of(" + elems + ")";
            case CHAR: return "Uint16Array.of(" + elems + ")";
            default: return "[" + elems + "]";
        }
    }

    String argList(String withLeadingComma) { return withLeadingComma.isEmpty() ? "" : withLeadingComma.substring(2); }

    static final Map<String, String> INLINE = new HashMap<>();
    static {
        String[][] m = {
            {"java.lang.Math.sqrt$D", "Math.sqrt"}, {"java.lang.Math.sin$D", "Math.sin"}, {"java.lang.Math.cos$D", "Math.cos"},
            {"java.lang.Math.tan$D", "Math.tan"}, {"java.lang.Math.atan$D", "Math.atan"}, {"java.lang.Math.atan2$D$D", "Math.atan2"},
            {"java.lang.Math.asin$D", "Math.asin"}, {"java.lang.Math.acos$D", "Math.acos"},
            {"java.lang.Math.pow$D$D", "Math.pow"}, {"java.lang.Math.exp$D", "Math.exp"}, {"java.lang.Math.log$D", "Math.log"},
            {"java.lang.Math.floor$D", "Math.floor"}, {"java.lang.Math.ceil$D", "Math.ceil"},
            {"java.lang.Math.abs$D", "Math.abs"}, {"java.lang.Math.abs$F", "Math.abs"},
            {"java.lang.Math.min$D$D", "Math.min"}, {"java.lang.Math.max$D$D", "Math.max"},
            {"java.lang.Math.min$F$F", "Math.min"}, {"java.lang.Math.max$F$F", "Math.max"},
            {"java.lang.Math.min$I$I", "Math.min"}, {"java.lang.Math.max$I$I", "Math.max"},
            {"java.lang.Math.hypot$D$D", "Math.hypot"}, {"java.lang.Math.toRadians$D", "$toRadians"}, {"java.lang.Math.toDegrees$D", "$toDegrees"},
        };
        for (String[] e : m) INLINE.put(e[0], e[1]);
    }

    /**
     * JADX drops implicit int->float widening casts, so a decompiled call like a(i3 - x, i4 - y) may now bind to an
     * a(int,int) overload although the bytecode called a(float,float). Report every such candidate for manual review.
     */
    void reviewOverload(JCMethodInvocation t, MethodSymbol ms, ClassSymbol owner) {
        List<Type> ps = types.erasure(ms.type).getParameterTypes();
        if (ps.isEmpty()) return;
        boolean hasInt = false;
        for (Type p : ps) if (p.getTag() == TypeTag.INT || p.getTag() == TypeTag.LONG) hasInt = true;
        if (!hasInt) return;
        Set<ClassSymbol> seen = new HashSet<>();
        for (Type st : types.closure(owner.type)) {
            if (!(st.tsym instanceof ClassSymbol) || !seen.add((ClassSymbol) st.tsym)) continue;
            for (Symbol o : st.tsym.members().getSymbolsByName(ms.name)) {
                if (!(o instanceof MethodSymbol) || o == ms) continue;
                List<Type> qs = types.erasure(o.type).getParameterTypes();
                if (qs.size() != ps.size()) continue;
                boolean floaty = false, ok = true;
                for (int i = 0; i < ps.size(); i++) {
                    TypeTag a = ps.get(i).getTag(), b = qs.get(i).getTag();
                    if (a == b) continue;
                    if ((a == TypeTag.INT || a == TypeTag.LONG) && (b == TypeTag.FLOAT || b == TypeTag.DOUBLE)) floaty = true; else ok = false;
                }
                if (ok && floaty) System.err.println("OVERLOAD-REVIEW " + fn.cls.flatname + ": " + t.toString().replace('\n', ' ') + "  bound to " + ms.owner.name + "." + ms.name + ps + "  sibling " + o.owner.name + "." + o.name + qs);
            }
        }
    }

    String call(JCMethodInvocation t) {
        Symbol rs = TreeInfo.symbol(t.meth);
        if (!(rs instanceof MethodSymbol)) throw new RuntimeException("unresolved call in " + fn.cls.flatname + ": " + t + " -> " + rs);
        MethodSymbol ms = (MethodSymbol) rs;
        ClassSymbol owner = (ClassSymbol) ms.owner;
        JCExpression sel = t.meth instanceof JCFieldAccess ? ((JCFieldAccess) t.meth).selected : null;
        String name = mname(ms);
        String qual = owner.getQualifiedName().toString();
        String args = callArgs(t.args, ms, t.varargsElement, false);
        String argl = argList(args);
        boolean extOwner = !model.isTranslated(owner);
        if (!extOwner) reviewOverload(t, ms, owner);

        // static -----------------------------------------------------------
        if (ms.isStatic()) {
            String inl = INLINE.get(qual + "." + name);
            if (inl != null) {
                if (name.equals("abs$I")) return "($abs(" + argl + "))";
                return inl + "(" + argl + ")";
            }
            if (extOwner) noteExternal(owner, name);
            return sref(owner, fn.cls) + "." + name + "(" + argl + ")";
        }

        // receiver
        String recv;
        boolean superCall = false;
        if (sel == null) {
            recv = outerPath(fn.cls, owner);
            if (isAnon(fn.cls) || !isSubClassOrSame(fn.cls, owner)) { /* outer method */ }
        } else if (sel instanceof JCIdent && ((JCIdent) sel).name.contentEquals("super")) {
            recv = "super"; superCall = true;
        } else if (sel instanceof JCFieldAccess && ((JCFieldAccess) sel).name.contentEquals("super")) {
            recv = "super"; superCall = true; // Outer.super.m() rarely
        } else recv = expr(sel);

        Type recvType = sel == null ? owner.type : sel.type;

        // java.lang.Object methods and value types -------------------------
        if (!superCall) {
            if (qual.equals("java.lang.Object")) {
                switch (ms.name.toString()) {
                    case "equals": return "$eq(" + recv + ", " + argl + ")";
                    case "hashCode": return "$hc(" + recv + ")";
                    case "toString": return "$ts(" + recv + ")";
                    case "getClass": return "$gc(" + recv + ")";
                    default: return recv + "." + name + "(" + argl + ")";
                }
            }
            if (qual.equals("java.lang.Comparable") && ms.name.contentEquals("compareTo")) return "$cmp(" + recv + ", " + argl + ")";
            if (isBoxedOrString(recvType) || isBoxedOrString(owner.type)) {
                String ns = isString(recvType) || qual.equals("java.lang.String") || qual.equals("java.lang.CharSequence") ? "$S" : "$N";
                // equals/hashCode/toString on boxed
                String nm = ms.name.toString();
                if (nm.equals("equals")) return "$eq(" + recv + ", " + argl + ")";
                if (nm.equals("hashCode")) return "$hc(" + recv + ")";
                if (nm.equals("toString") && ms.params().isEmpty()) return "$ts(" + recv + ")";
                if (nm.equals("compareTo")) return "$cmp(" + recv + ", " + argl + ")";
                noteExternal(owner, name);
                return ns + "." + name + "(" + recv + (argl.isEmpty() ? "" : ", " + argl) + ")";
            }
        }
        if (extOwner) noteExternal(owner, name);
        return recv + "." + name + "(" + argl + ")";
    }

    boolean isAnon(ClassSymbol c) { return c.name.isEmpty(); }

    // object creation ---------------------------------------------------------
    String newClass(JCNewClass nc) {
        ClassSymbol cs = (ClassSymbol) nc.clazz.type.tsym;
        MethodSymbol ctor = (MethodSymbol) nc.constructor;
        String args = callArgs(nc.args, ctor, nc.varargsElement, false);
        String argl = argList(args);
        String q = cs.getQualifiedName().toString();
        if (nc.def == null) {
            switch (q) {
                case "java.lang.Integer": case "java.lang.Long": case "java.lang.Short": case "java.lang.Byte": case "java.lang.Float":
                case "java.lang.Double": case "java.lang.Boolean": case "java.lang.Character": case "java.lang.String":
                    return jsClass(cs) + ".$new$" + joinSigs(ctor.type.getParameterTypes()) + "(" + argl + ")";
                default:
            }
        }
        String clsJs;
        String initName = mname(ctor);
        if (nc.def != null) {
            clsJs = "(" + genClassExpr(nc.def, "class", false) + ")";
        } else {
            clsJs = jsClass(cs);
            if (!model.isTranslated(cs)) noteExternal(cs, initName);
        }
        String creation = "new " + clsJs + "()";
        boolean needsOuter = nc.def != null ? !fn.isStatic : (cs.owner instanceof ClassSymbol && !cs.isStatic() && cs.hasOuterInstance());
        if (needsOuter) {
            String outerExpr;
            if (nc.encl != null) outerExpr = expr(nc.encl);
            else if (nc.def != null) outerExpr = "this";
            else outerExpr = outerPath(fn.cls, (ClassSymbol) cs.owner.enclClass());
            creation = "$wo(" + creation + ", " + outerExpr + ")";
        }
        return creation + "." + initName + "(" + argl + ")";
    }

    String newArray(JCNewArray na) {
        Type at = na.type; // array type
        if (na.elems != null) {
            Type elem = ((ArrayType) at).elemtype;
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < na.elems.size(); i++) {
                if (i > 0) sb.append(", ");
                JCExpression el = na.elems.get(i);
                sb.append(conv(expr(el), el.type, elem));
            }
            return arrayLiteral(elem, sb.toString());
        }
        // dims
        List<JCExpression> dims = na.dims;
        Type t = at;
        List<String> d = new ArrayList<>();
        for (JCExpression x : dims) d.add(conv(expr(x), x.type, syms.intType));
        for (int i = 0; i < dims.size() && t.getTag() == TypeTag.ARRAY; i++) t = ((ArrayType) t).elemtype;
        // t is now the element type of the allocated leaf dimension (could itself be an array if partially allocated)
        String leaf = leafKind(t);
        if (d.size() == 1) return "$newArr(" + d.get(0) + ", " + leaf + ")";
        return "$newMulti([" + String.join(", ", d) + "], " + leaf + ")";
    }

    String leafKind(Type t) {
        switch (kindOf(t)) {
            case INT: return "\"I\""; case FLOAT: return "\"F\""; case DOUBLE: return "\"D\""; case LONG: return "\"J\"";
            case BYTE: return "\"B\""; case SHORT: return "\"S\""; case CHAR: return "\"C\""; case BOOL: return "\"Z\"";
            default: return "\"L\"";
        }
    }

    // operators ---------------------------------------------------------------
    String binary(JCBinary b) {
        Tag tag = b.getTag();
        if (tag == Tag.AND) return "(" + expr(b.lhs) + " && " + expr(b.rhs) + ")";
        if (tag == Tag.OR) return "(" + expr(b.lhs) + " || " + expr(b.rhs) + ")";
        if (tag == Tag.PLUS && isString(b.type)) return concat(b);
        com.sun.tools.javac.util.List<Type> ps = b.operator.type.getParameterTypes();
        Type lt = ps.head, rt = ps.tail.head;
        K k = kindOf(lt);
        boolean nullCmp = false;
        if (tag == Tag.EQ || tag == Tag.NE) {
            boolean lnull = b.lhs.type != null && b.lhs.type.getTag() == TypeTag.BOT;
            boolean rnull = b.rhs.type != null && b.rhs.type.getTag() == TypeTag.BOT;
            if (lnull || rnull) {
                String a = expr(b.lhs), c = expr(b.rhs);
                return "(" + a + (tag == Tag.EQ ? " == " : " != ") + c + ")";
            }
        }
        String a = convE(b.lhs, lt);
        String c = convE(b.rhs, rt);
        switch (tag) {
            case PLUS: return arith(k, "+", a, c);
            case MINUS: return arith(k, "-", a, c);
            case MUL: return arith(k, "*", a, c);
            case DIV: return arith(k, "/", a, c);
            case MOD: return arith(k, "%", a, c);
            case SL: case SR: case USR: return shift(tag, kindOf(lt), kindOf(rt), a, c);
            case BITAND: case BITOR: case BITXOR: return bitop(tag, k, a, c);
            case EQ: return "(" + a + " === " + c + ")";
            case NE: return "(" + a + " !== " + c + ")";
            case LT: return "(" + a + " < " + c + ")";
            case GT: return "(" + a + " > " + c + ")";
            case LE: return "(" + a + " <= " + c + ")";
            case GE: return "(" + a + " >= " + c + ")";
            default: throw new RuntimeException("binary op " + tag);
        }
    }

    String arith(K k, String op, String a, String c) {
        switch (k) {
            case INT: case SHORT: case BYTE: case CHAR:
                switch (op) {
                    case "*": return "Math.imul(" + a + ", " + c + ")";
                    case "/": return "$idiv(" + a + ", " + c + ")";
                    case "%": return "$irem(" + a + ", " + c + ")";
                    default: return "(" + a + " " + op + " " + c + " | 0)";
                }
            case LONG:
                switch (op) {
                    case "/": return "$ldiv(" + a + ", " + c + ")";
                    case "%": return "$lrem(" + a + ", " + c + ")";
                    default: return "$l(" + a + " " + op + " " + c + ")";
                }
            case FLOAT: return "Math.fround(" + a + " " + op + " " + c + ")";
            default: return "(" + a + " " + op + " " + c + ")";
        }
    }

    String shift(Tag tag, K lk, K rk, String a, String c) {
        if (lk == K.LONG) {
            String n = rk == K.LONG ? "Number(" + c + " & 63n)" : "(" + c + " & 63)";
            switch (tag) {
                case SL: return "$l(" + a + " << BigInt(" + n + "))";
                case SR: return "(" + a + " >> BigInt(" + n + "))";
                default: return "$l(BigInt.asUintN(64, " + a + ") >> BigInt(" + n + "))";
            }
        }
        String n = rk == K.LONG ? "$l2i(" + c + ")" : c;
        switch (tag) {
            case SL: return "(" + a + " << " + n + ")";
            case SR: return "(" + a + " >> " + n + ")";
            default: return "(" + a + " >>> " + n + " | 0)";
        }
    }

    String bitop(Tag tag, K k, String a, String c) {
        String op = tag == Tag.BITAND ? "&" : tag == Tag.BITOR ? "|" : "^";
        if (k == K.BOOL) {
            if (tag == Tag.BITXOR) return "(" + a + " !== " + c + ")";
            return "!!(" + a + " " + op + " " + c + ")";
        }
        return "(" + a + " " + op + " " + c + ")";
    }

    String strOf(JCExpression e) {
        String c = constOf(e);
        if (c != null && isString(e.type)) return c;
        String js = expr(e);
        Type t = e.type;
        if (t.getTag() == TypeTag.BOT) return "\"null\"";
        switch (valueKind(t)) {
            case BOOL: if (t.isPrimitive()) return js; return "$ostr(" + js + ")";
            case INT: case SHORT: case BYTE: if (t.isPrimitive()) return js; return "$ostr(" + js + ")";
            case LONG: if (t.isPrimitive()) return "String(" + js + ")"; return "$ostr(" + js + ")";
            case FLOAT: if (t.isPrimitive()) return "$fstr(" + js + ")"; return "$ostr(" + js + ", \"F\")";
            case DOUBLE: if (t.isPrimitive()) return "$dstr(" + js + ")"; return "$ostr(" + js + ", \"D\")";
            case CHAR: if (t.isPrimitive()) return "String.fromCharCode(" + js + ")"; return "$ostr(" + js + ", \"C\")";
            default:
                if (isString(t)) return "$sn(" + js + ")";
                return "$ostr(" + js + ")";
        }
    }

    String concat(JCBinary b) {
        List<JCExpression> parts = new ArrayList<>();
        flattenConcat(b, parts);
        StringBuilder sb = new StringBuilder("(");
        for (int i = 0; i < parts.size(); i++) {
            if (i > 0) sb.append(" + ");
            String s = strOf(parts.get(i));
            sb.append(i == 0 && !isString(parts.get(0).type) ? "\"\" + " + s : s);
        }
        // guarantee string typing even when first two operands are numeric (can't happen: Java left-assoc makes first op string)
        return sb.append(")").toString();
    }

    void flattenConcat(JCExpression e, List<JCExpression> out) {
        JCExpression x = e;
        if (x instanceof JCBinary && x.getTag() == Tag.PLUS && isString(x.type) && constOf(x) == null) {
            flattenConcat(((JCBinary) x).lhs, out);
            out.add(((JCBinary) x).rhs);
        } else out.add(e);
    }

    String unary(JCUnary u) {
        Tag tag = u.getTag();
        switch (tag) {
            case PREINC: case POSTINC: return incDec(u.arg, true, tag == Tag.POSTINC);
            case PREDEC: case POSTDEC: return incDec(u.arg, false, tag == Tag.POSTDEC);
            default:
        }
        Type pt = u.operator.type.getParameterTypes().head;
        String a = conv(expr(u.arg), u.arg.type, pt);
        K k = kindOf(pt);
        switch (tag) {
            case NOT: return "(!" + a + ")";
            case POS: return a;
            case NEG:
                if (k == K.INT) return "(-" + a + " | 0)";
                if (k == K.LONG) return "$l(-" + a + ")";
                return "(-" + a + ")";
            case COMPL: return "(~" + a + ")";
            default: throw new RuntimeException("unary " + tag);
        }
    }

    // lvalues -----------------------------------------------------------------
    class LV { String setup = ""; String get; String setPrefix; Type type; }

    boolean simple(JCExpression e) {
        e = TreeInfo.skipParens(e);
        if (e instanceof JCLiteral) return true;
        if (e instanceof JCIdent) return true;
        if (e instanceof JCFieldAccess) {
            JCFieldAccess f = (JCFieldAccess) e;
            if (f.sym instanceof VarSymbol && ((VarSymbol) f.sym).isStatic()) return true;
            return simple(f.selected);
        }
        return false;
    }

    LV lvalue(JCExpression e) {
        e = TreeInfo.skipParens(e);
        LV lv = new LV();
        lv.type = e.type;
        if (e instanceof JCArrayAccess) {
            JCArrayAccess a = (JCArrayAccess) e;
            String arr = expr(a.indexed);
            String idx = conv(expr(a.index), a.index.type, syms.intType);
            if (!simple(a.indexed)) { String t = fn.tmp(); lv.setup += t + " = " + arr + ", "; arr = t; }
            if (!(simple(a.index) || a.index instanceof JCLiteral)) { String t = fn.tmp(); lv.setup += t + " = " + idx + ", "; idx = t; }
            lv.get = arr + "[" + idx + "]";
            lv.setPrefix = lv.get;
        } else if (e instanceof JCFieldAccess && ((JCFieldAccess) e).sym instanceof VarSymbol && !((VarSymbol) ((JCFieldAccess) e).sym).isStatic()) {
            JCFieldAccess f = (JCFieldAccess) e;
            String recv = expr(f.selected);
            if (!simple(f.selected)) { String t = fn.tmp(); lv.setup += t + " = " + recv + ", "; recv = t; }
            lv.get = recv + "." + fname((VarSymbol) f.sym);
            lv.setPrefix = lv.get;
        } else {
            lv.get = expr(e);
            lv.setPrefix = lv.get;
        }
        return lv;
    }

    String assign(JCAssign a) {
        LV lv = lvalue(a.lhs);
        String v = convE(a.rhs, a.lhs.type);
        String r = lv.setPrefix + " = " + v;
        return lv.setup.isEmpty() ? "(" + r + ")" : "(" + lv.setup + r + ")";
    }

    String assignOp(JCAssignOp a) {
        LV lv = lvalue(a.lhs);
        com.sun.tools.javac.util.List<Type> ps = a.operator.type.getParameterTypes();
        Type lt = ps.head, rt = ps.tail.head;
        Tag tag = a.getTag();
        String res;
        if (tag == Tag.PLUS_ASG && isString(a.lhs.type)) {
            res = "$sn(" + lv.get + ") + " + strOf(a.rhs);
        } else {
            String cur = conv(lv.get, a.lhs.type, lt);
            String rhs = convE(a.rhs, rt);
            K k = kindOf(lt);
            String op;
            switch (tag) {
                case PLUS_ASG: res = arith(k, "+", cur, rhs); break;
                case MINUS_ASG: res = arith(k, "-", cur, rhs); break;
                case MUL_ASG: res = arith(k, "*", cur, rhs); break;
                case DIV_ASG: res = arith(k, "/", cur, rhs); break;
                case MOD_ASG: res = arith(k, "%", cur, rhs); break;
                case SL_ASG: res = shift(Tag.SL, k, kindOf(rt), cur, rhs); break;
                case SR_ASG: res = shift(Tag.SR, k, kindOf(rt), cur, rhs); break;
                case USR_ASG: res = shift(Tag.USR, k, kindOf(rt), cur, rhs); break;
                case BITAND_ASG: res = bitop(Tag.BITAND, k, cur, rhs); break;
                case BITOR_ASG: res = bitop(Tag.BITOR, k, cur, rhs); break;
                case BITXOR_ASG: res = bitop(Tag.BITXOR, k, cur, rhs); break;
                default: throw new RuntimeException("assignop " + tag);
            }
            res = conv(res, lt, a.lhs.type);
        }
        String r = lv.setPrefix + " = " + res;
        return lv.setup.isEmpty() ? "(" + r + ")" : "(" + lv.setup + r + ")";
    }

    String incDec(JCExpression target, boolean inc, boolean postfix) {
        Type t = target.type;
        K k = valueKind(t);
        LV lv = lvalue(target);
        boolean cheap = (k == K.INT) && lv.setup.isEmpty();
        if (cheap) {
            String op = inc ? "++" : "--";
            return postfix ? "(" + lv.get + op + ")" : "(" + op + lv.get + ")";
        }
        String one = k == K.LONG ? "1n" : "1";
        String sum;
        switch (k) {
            case LONG: sum = "$l(" + lv.get + (inc ? " + " : " - ") + one + ")"; break;
            case FLOAT: sum = "Math.fround(" + lv.get + (inc ? " + " : " - ") + one + ")"; break;
            case DOUBLE: sum = "(" + lv.get + (inc ? " + " : " - ") + one + ")"; break;
            case INT: sum = "(" + lv.get + (inc ? " + " : " - ") + one + " | 0)"; break;
            case SHORT: sum = "((" + lv.get + (inc ? " + " : " - ") + one + ") << 16 >> 16)"; break;
            case BYTE: sum = "((" + lv.get + (inc ? " + " : " - ") + one + ") << 24 >> 24)"; break;
            case CHAR: sum = "((" + lv.get + (inc ? " + " : " - ") + one + ") & 65535)"; break;
            default: throw new RuntimeException("inc/dec on " + t);
        }
        if (!postfix) return "(" + lv.setup + lv.setPrefix + " = " + sum + ")";
        String old = fn.tmp();
        return "(" + lv.setup + old + " = " + lv.get + ", " + lv.setPrefix + " = " + sum.replace(lv.get, old) + ", " + old + ")";
    }

    String cast(JCTypeCast c) {
        Type to = c.clazz.type;
        Type from = c.expr.type;
        String js = expr(c.expr);
        if (to.isPrimitive()) {
            K f = valueKind(from), t = kindOf(to);
            if (f == K.REF) return js; // (int) obj : unbox
            return conv(js, from.isPrimitive() ? from : types.unboxedType(from), to);
        }
        // boxing / reference cast
        if (from.isPrimitive()) {
            Type unb = types.unboxedType(to);
            if (unb != null && unb.getTag() != TypeTag.NONE) return conv(js, from, unb);
        }
        return js;
    }

    String instanceOf(JCInstanceOf io) {
        Type t = io.pattern.type;
        String v = expr(io.expr);
        return instanceTest(v, t);
    }

    String instanceTest(String v, Type t) {
        if (t.getTag() == TypeTag.ARRAY) return "$isArr(" + v + ")";
        ClassSymbol c = (ClassSymbol) t.tsym;
        String q = c.getQualifiedName().toString();
        switch (q) {
            case "java.lang.Object": return "(" + v + " != null)";
            case "java.lang.String": return "(typeof " + v + " === \"string\")";
            case "java.lang.Integer": case "java.lang.Short": case "java.lang.Byte": case "java.lang.Float": case "java.lang.Double": case "java.lang.Number":
                return "(typeof " + v + " === \"number\")";
            case "java.lang.Long": return "(typeof " + v + " === \"bigint\")";
            case "java.lang.Boolean": return "(typeof " + v + " === \"boolean\")";
            default:
        }
        if (!model.isTranslated(c)) noteExternal(c, null);
        if (isInterface(c)) return "$isI(" + v + ", " + jsString(jsClass(c)) + ")";
        return "(" + v + " instanceof " + jsClass(c) + ")";
    }

    String lambda(JCLambda l) {
        throw new RuntimeException("lambda not supported yet: " + l);
    }

    String memberRef(JCMemberReference m) {
        throw new RuntimeException("method reference not supported yet: " + m);
    }
}
