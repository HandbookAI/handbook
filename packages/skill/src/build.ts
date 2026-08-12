/**
 * Package a rendered handbook directory as an agent SKILL:
 *
 * ```
 * <out>/
 *   SKILL.md                 navigation guide (how an agent should route)
 *   references/
 *     overview.md  index.md  registers.md
 *     stages/<sid>.md        one page per stage
 *     agent/                 index.md + symbols.tsv + files.tsv + calls.tsv + stages/ (optional)
 *     coverage.json          file → stage + content hashes (optional, drift signal)
 * ```
 *
 * The skill is self-contained and shareable; it never embeds source code.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, join, normalize, resolve, sep } from 'node:path';
import {
  PIPELINE_DEFAULTS,
  ensureDir,
  fileExists,
  isAbsoluteAnyPlatform,
  listFilesRecursive,
  sha256Hex,
  writeFileAtomic,
  writeJsonFile,
  type Assignment,
  type NarrateLang,
} from '@handbook/core';

export interface BuildSkillOptions {
  /** Rendered handbook dir (contains overview.md/index.md/register.md/<sid>.md). */
  handbookDir: string;
  outDir: string;
  /** Skill slug, e.g. `myproject`. Produces name `<slug>-handbook`. */
  name: string;
  /** Human project name used in prose. Defaults to `name`. */
  project?: string;
  /** When given, coverage.json records file→stage plus source hashes for drift detection. */
  coverage?: { assignment: Assignment; sourceRoot?: string };
  /**
   * Rendered agent artifact. When it contains the entry index and all three
   * fact tables, they ship under `references/agent/` (with `stages/` alongside
   * if present) and the SKILL.md routing protocol gains its grep recipes.
   * Omitted, or missing any of the four: output is byte-identical to a build
   * without this option — SKILL.md must never route to a file that is not there.
   */
  agentDir?: string;
  /**
   * Language of the SKILL.md BODY and synthetic fallback prose (default `en`).
   * The YAML frontmatter (`name` + `description`) stays English regardless:
   * agent runtimes route skills on the description text, and the validated
   * "Use when …" / "Do not use …" contract is part of that routing surface —
   * translating it would silently break skill selection.
   */
  lang?: NarrateLang;
}

export interface BuildSkillResult {
  outDir: string;
  nStagePages: number;
  references: string[];
}

/** Root-level pages that are NOT stage pages in a flat rendered handbook. */
const NON_STAGE_PAGES = new Set(['overview.md', 'index.md', 'register.md', 'registers.md', 'readme.md']);

/** SKILL.md body copy plus synthetic fallback prose, per narrate language. */
interface SkillCopy {
  header: (project: string) => string;
  /** Unnumbered routing steps; `agent` is spliced in before `source` when the locator pages ship. */
  steps: {
    overview: string;
    index: string;
    stages: string;
    registers: string;
    agent: string;
    source: string;
  };
  coverage: string;
  /** The corrections protocol: how a consuming agent reports handbook↔source contradictions. */
  corrections: string;
  noRegisters: string;
}

/**
 * The one-line JSON example shown verbatim in every SKILL.md body (both
 * languages): agents copy its shape, so it must match `corrections.jsonl`'s
 * contract exactly — `file` required, the rest optional.
 */
const CORRECTION_EXAMPLE =
  '{"file": "src/engine.py", "page": "references/stages/stage-2.md", "claim": "spin() is defined in src/main.py", "actual": "spin() is defined in src/engine.py", "notedAt": "2026-08-04T12:00:00Z"}';

const SKILL_COPY: Record<NarrateLang, SkillCopy> = {
  en: {
    header: (project) => `# ${project} Handbook — how to use it

This handbook is a **location index** for the ${project} codebase, not a code description.
Use it to decide WHICH files, functions and state a change must touch — then read the real source.`,
    steps: {
      overview: "Read `references/overview.md` for the system's shape.",
      index: 'Route through `references/index.md` — the stage index maps every subsystem to its files.',
      stages: 'Open only the relevant `references/stages/<id>.md` pages.',
      registers: 'Check `references/registers.md` for cross-cutting state — invaluable for fan-out changes.',
      agent:
        'For a symbol, a file or a caller, grep the fact tables instead of guessing: `grep "^NAME\t" references/agent/symbols.tsv` gives `path:startLine-endLine`; `grep "\tNAME\t" references/agent/calls.tsv` gives its callers. `references/agent/index.md` lists every recipe. Locations are parser-derived; open the file and read the range before editing.',
      source: '`read_file` the actual source at every cited path before proposing or making changes.',
    },
    coverage: `If \`references/coverage.json\` exists, treat its content hashes as freshness signals: a stale
hash means the page may lag the code. Do NOT treat handbook prose as ground truth for code
text — always confirm against the real source before emitting a verbatim edit.`,
    corrections: `## Corrections

When a handbook claim contradicts the real source ("the handbook says X is in file A; it is
actually in B"), report it: append ONE line of JSON to \`corrections.jsonl\` at the skill root
(next to this SKILL.md — never under \`references/\`, which planners mount read-only). Create
the file on first write. One object per line:

\`\`\`json
${CORRECTION_EXAMPLE}
\`\`\`

\`file\` is the repo-relative source path (required); \`page\` is the references/ page that
carried the claim; \`claim\`/\`actual\` state the contradiction; \`notedAt\` is an ISO timestamp —
all optional. Never edit anything under \`references/\` yourself: a later resync consumes
\`corrections.jsonl\` and refreshes exactly the named files. Keep working from the real source.`,
    noRegisters: '# State registers\n\n_No cross-stage state registers were identified for this codebase._\n',
  },
  zh: {
    header: (project) => `# ${project} 手册 —— 使用说明

本手册是 ${project} 代码库的**位置索引**，不是代码描述。
用它来决定一次修改必须触及哪些文件、函数与状态 —— 然后去读真实源码。`,
    steps: {
      overview: '先读 `references/overview.md`，了解系统的整体形状。',
      index: '通过 `references/index.md` 路由 —— 阶段索引把每个子系统映射到它的文件。',
      stages: '只打开相关的 `references/stages/<id>.md` 页面。',
      registers: '查 `references/registers.md` 的跨阶段状态 —— 对波及面大的修改尤其关键。',
      agent:
        '查符号、文件或调用方时，直接 grep 事实表，不要猜：`grep "^NAME\t" references/agent/symbols.tsv` 给出 `路径:起始行-结束行`；`grep "\tNAME\t" references/agent/calls.tsv` 给出它的调用方。全部检索配方见 `references/agent/index.md`。位置来自解析器；动手改之前先打开文件读那段行号。',
      source: '在提出或做出任何修改之前，`read_file` 每个被引用路径的真实源码。',
    },
    coverage: `如果 \`references/coverage.json\` 存在，把其中的内容哈希当作新鲜度信号：哈希过期意味着
页面可能落后于代码。不要把手册散文当作代码文本的事实依据 —— 在输出逐字修改之前，
务必对照真实源码确认。`,
    corrections: `## 更正记录（Corrections）

当手册的断言与真实源码矛盾时（「手册说 X 在文件 A，实际在 B」），请上报：向 skill 根目录的
\`corrections.jsonl\`（与本 SKILL.md 同级 —— 绝不写进 \`references/\`，那棵树是只读挂载的）
追加一行 JSON，文件不存在就先创建。每行一个对象：

\`\`\`json
${CORRECTION_EXAMPLE}
\`\`\`

\`file\` 是仓库相对的源码路径（必填）；\`page\` 是承载该断言的 references/ 页面；
\`claim\`/\`actual\` 陈述矛盾本身；\`notedAt\` 是 ISO 时间戳 —— 除 \`file\` 外均可选。
绝不要自己改动 \`references/\` 下的任何内容：之后的 resync 会消费 \`corrections.jsonl\`，
只刷新被点名的文件。在此期间继续以真实源码为准。`,
    noRegisters: '# 状态寄存器\n\n_本代码库未识别出跨阶段的状态寄存器。_\n',
  },
  hi: {
    header: (project) => `# ${project} Handbook — इस्तेमाल कैसे करें

यह handbook ${project} कोडबेस का एक **लोकेशन इंडेक्स** है, कोड का विवरण नहीं।
इससे तय कीजिए कि किसी बदलाव को कौन-सी फ़ाइलें, फ़ंक्शन और state छूने होंगे — फिर असली सोर्स पढ़िए।`,
    steps: {
      overview: 'सिस्टम का आकार समझने के लिए `references/overview.md` पढ़िए।',
      index: '`references/index.md` से रूट कीजिए — stage इंडेक्स हर सबसिस्टम को उसकी फ़ाइलों से जोड़ता है।',
      stages: 'सिर्फ़ ज़रूरी `references/stages/<id>.md` पेज खोलिए।',
      registers:
        'क्रॉसकट state के लिए `references/registers.md` देखिए — बिखरे हुए बदलावों में यह सबसे काम का है।',
      agent:
        'किसी symbol, file या caller के लिए अनुमान न लगाइए — fact tables पर grep कीजिए: `grep "^NAME\t" references/agent/symbols.tsv` से `path:startLine-endLine` मिलता है; `grep "\tNAME\t" references/agent/calls.tsv` से उसके callers। सारी recipes `references/agent/index.md` में हैं। ये स्थान parser से आते हैं; बदलने से पहले file खोलकर वह range पढ़िए।',
      source: 'कोई भी बदलाव प्रस्तावित करने या करने से पहले हर उद्धृत पथ का असली सोर्स `read_file` कीजिए।',
    },
    coverage: `अगर \`references/coverage.json\` मौजूद है, तो उसके content हैश को ताज़गी के संकेत की तरह लीजिए: पुराना
हैश यानी पेज कोड से पीछे हो सकता है। Handbook की भाषा को कोड टेक्स्ट का प्रमाण मत मानिए — कोई भी
शब्दशः बदलाव देने से पहले असली सोर्स से मिलान कीजिए।`,
    corrections: `## सुधार (Corrections)

जब handbook का कोई दावा असली सोर्स से टकराए ("handbook कहता है X फ़ाइल A में है; असल में वह B में है"),
तो उसे दर्ज कीजिए: skill की जड़ में मौजूद \`corrections.jsonl\` में JSON की एक पंक्ति जोड़िए (इसी
SKILL.md के बग़ल में — कभी \`references/\` के भीतर नहीं, जिसे planner सिर्फ़ पढ़ने के लिए माउंट करते हैं)।
पहली बार लिखते समय फ़ाइल बना लीजिए। हर पंक्ति में एक ऑब्जेक्ट:

\`\`\`json
${CORRECTION_EXAMPLE}
\`\`\`

\`file\` रिपॉज़िटरी-सापेक्ष सोर्स पथ है (अनिवार्य); \`page\` वह references/ पेज है जिस पर दावा था;
\`claim\`/\`actual\` विरोधाभास बताते हैं; \`notedAt\` एक ISO टाइमस्टैम्प है — बाक़ी सब वैकल्पिक।
\`references/\` के नीचे कुछ भी ख़ुद मत बदलिए: बाद का resync \`corrections.jsonl\` को पढ़कर ठीक उन्हीं
फ़ाइलों को ताज़ा करता है। तब तक असली सोर्स से ही काम करते रहिए।`,
    noRegisters:
      '# State registers\n\n_इस कोडबेस में stages के आर-पार जाने वाला कोई state register नहीं मिला।_\n',
  },
  es: {
    header: (project) => `# ${project} Handbook — cómo usarlo

Este handbook es un **índice de ubicación** del código de ${project}, no una descripción del código.
Úsalo para decidir QUÉ archivos, funciones y estado debe tocar un cambio — luego lee el código real.`,
    steps: {
      overview: 'Lee `references/overview.md` para ver la forma del sistema.',
      index:
        'Enruta por `references/index.md` — el índice de etapas conecta cada subsistema con sus archivos.',
      stages: 'Abre solo las páginas `references/stages/<id>.md` relevantes.',
      registers:
        'Consulta `references/registers.md` para el estado transversal — es valiosísimo en cambios de mucho alcance.',
      agent:
        'Para un símbolo, un archivo o quién lo llama, haz grep en las tablas de hechos en vez de adivinar: `grep "^NAME\t" references/agent/symbols.tsv` da `ruta:líneaInicio-líneaFin`; `grep "\tNAME\t" references/agent/calls.tsv` da quién lo llama. Todas las recetas están en `references/agent/index.md`. Las ubicaciones vienen del parser; abre el archivo y lee el rango antes de editar.',
      source: 'Haz `read_file` del código real en cada ruta citada antes de proponer o hacer cambios.',
    },
    coverage: `Si existe \`references/coverage.json\`, trata sus hashes de contenido como señales de frescura: un hash
obsoleto significa que la página puede ir por detrás del código. NO tomes la prosa del handbook como
verdad para el texto del código — confirma siempre contra el código real antes de emitir una edición
literal.`,
    corrections: `## Correcciones

Cuando una afirmación del handbook contradiga el código real ("el handbook dice que X está en el archivo
A; en realidad está en B"), repórtalo: añade UNA línea de JSON a \`corrections.jsonl\` en la raíz del skill
(junto a este SKILL.md — nunca bajo \`references/\`, que los planificadores montan en solo lectura). Crea
el archivo en la primera escritura. Un objeto por línea:

\`\`\`json
${CORRECTION_EXAMPLE}
\`\`\`

\`file\` es la ruta del código relativa al repositorio (obligatoria); \`page\` es la página de references/
que contenía la afirmación; \`claim\`/\`actual\` describen la contradicción; \`notedAt\` es una marca de
tiempo ISO — todos opcionales. Nunca edites nada bajo \`references/\` por tu cuenta: un resync posterior
consume \`corrections.jsonl\` y refresca exactamente los archivos nombrados. Sigue trabajando desde el
código real.`,
    noRegisters:
      '# Registros de estado\n\n_No se identificó ningún registro de estado entre etapas para este código._\n',
  },
  pt: {
    header: (project) => `# ${project} Handbook — como usar

Este handbook é um **índice de localização** da base de código do ${project}, não uma descrição do código.
Use-o para decidir QUAIS arquivos, funções e estado uma mudança precisa tocar — depois leia o código real.`,
    steps: {
      overview: 'Leia `references/overview.md` para ver o formato do sistema.',
      index:
        'Roteie por `references/index.md` — o índice de etapas mapeia cada subsistema para os seus arquivos.',
      stages: 'Abra apenas as páginas `references/stages/<id>.md` relevantes.',
      registers:
        'Consulte `references/registers.md` para o estado transversal — é valiosíssimo em mudanças de grande alcance.',
      agent:
        'Para um símbolo, um arquivo ou quem o chama, faça grep nas tabelas de fatos em vez de adivinhar: `grep "^NAME\t" references/agent/symbols.tsv` dá `caminho:linhaInicial-linhaFinal`; `grep "\tNAME\t" references/agent/calls.tsv` dá quem o chama. Todas as receitas estão em `references/agent/index.md`. As localizações vêm do parser; abra o arquivo e leia o intervalo antes de editar.',
      source: 'Faça `read_file` do código real em cada caminho citado antes de propor ou fazer mudanças.',
    },
    coverage: `Se \`references/coverage.json\` existir, trate os seus hashes de conteúdo como sinais de atualidade: um
hash desatualizado significa que a página pode estar atrás do código. NÃO trate a prosa do handbook como
verdade sobre o texto do código — confirme sempre no código real antes de emitir uma edição literal.`,
    corrections: `## Correções

Quando uma afirmação do handbook contradisser o código real ("o handbook diz que X está no arquivo A; na
verdade está em B"), reporte: acrescente UMA linha de JSON a \`corrections.jsonl\` na raiz do skill (ao
lado deste SKILL.md — nunca sob \`references/\`, que os planejadores montam somente para leitura). Crie o
arquivo na primeira escrita. Um objeto por linha:

\`\`\`json
${CORRECTION_EXAMPLE}
\`\`\`

\`file\` é o caminho do fonte relativo ao repositório (obrigatório); \`page\` é a página de references/ que
carregava a afirmação; \`claim\`/\`actual\` declaram a contradição; \`notedAt\` é um timestamp ISO — todos
opcionais. Nunca edite nada sob \`references/\` por conta própria: um resync posterior consome
\`corrections.jsonl\` e atualiza exatamente os arquivos citados. Continue trabalhando a partir do código
real.`,
    noRegisters:
      '# Registradores de estado\n\n_Nenhum registrador de estado entre etapas foi identificado para esta base de código._\n',
  },
  ru: {
    header: (project) => `# ${project} Handbook — как им пользоваться

Этот handbook — **указатель мест** в кодовой базе ${project}, а не описание кода.
По нему решайте, КАКИЕ файлы, функции и состояние затронет изменение, — а затем читайте настоящий исходник.`,
    steps: {
      overview: 'Прочитайте `references/overview.md`, чтобы увидеть форму системы.',
      index:
        'Ориентируйтесь по `references/index.md` — указатель этапов связывает каждую подсистему с её файлами.',
      stages: 'Открывайте только нужные страницы `references/stages/<id>.md`.',
      registers:
        'Смотрите `references/registers.md` для сквозного состояния — незаменимо при изменениях с широким охватом.',
      agent:
        'Чтобы найти символ, файл или вызывающий код, используйте grep по таблицам фактов, а не догадки: `grep "^NAME\t" references/agent/symbols.tsv` даёт `путь:перваяСтрока-последняяСтрока`; `grep "\tNAME\t" references/agent/calls.tsv` даёт вызывающих. Все рецепты — в `references/agent/index.md`. Позиции получены парсером; откройте файл и прочитайте диапазон перед правкой.',
      source:
        'Прежде чем предлагать или вносить изменения, сделайте `read_file` настоящего исходника по каждому упомянутому пути.',
    },
    coverage: `Если \`references/coverage.json\` существует, считайте его хеши содержимого сигналами свежести:
устаревший хеш означает, что страница может отставать от кода. НЕ считайте текст handbook источником
истины о коде — перед выдачей дословной правки всегда сверяйтесь с настоящим исходником.`,
    corrections: `## Исправления (Corrections)

Когда утверждение handbook противоречит настоящему исходнику («handbook говорит, что X находится в файле
A; на самом деле — в B»), сообщите об этом: допишите ОДНУ строку JSON в \`corrections.jsonl\` в корне
skill (рядом с этим SKILL.md — никогда внутрь \`references/\`, которую планировщики монтируют только для
чтения). При первой записи создайте файл. По одному объекту на строку:

\`\`\`json
${CORRECTION_EXAMPLE}
\`\`\`

\`file\` — путь к исходнику относительно репозитория (обязателен); \`page\` — страница references/, на
которой было утверждение; \`claim\`/\`actual\` описывают противоречие; \`notedAt\` — метка времени ISO —
всё остальное необязательно. Никогда не правьте ничего под \`references/\` сами: последующий resync
читает \`corrections.jsonl\` и обновляет ровно названные файлы. Продолжайте работать с настоящим
исходником.`,
    noRegisters:
      '# Регистры состояния\n\n_Для этой кодовой базы межэтапные регистры состояния не выявлены._\n',
  },
  ja: {
    header: (project) => `# ${project} Handbook — 使い方

この handbook は ${project} コードベースの**場所の索引**であり、コードの説明ではありません。
変更がどのファイル・関数・状態に触れるべきかを決めるために使い、そのうえで実際のソースを読んでください。`,
    steps: {
      overview: 'システムの形をつかむために `references/overview.md` を読んでください。',
      index:
        '`references/index.md` を経由して辿ってください — ステージ索引が各サブシステムをそのファイルに対応づけます。',
      stages: '関係する `references/stages/<id>.md` のページだけを開いてください。',
      registers:
        '横断的な状態は `references/registers.md` で確認してください — 影響が広がる変更ではとくに有用です。',
      agent:
        'シンボル・ファイル・呼び出し元を探すときは推測せず事実テーブルを grep してください: `grep "^NAME\t" references/agent/symbols.tsv` で `パス:開始行-終了行`、`grep "\tNAME\t" references/agent/calls.tsv` で呼び出し元が得られます。全レシピは `references/agent/index.md` にあります。位置はパーサ由来です。編集の前にファイルを開いてその行範囲を読んでください。',
      source: '変更を提案・実施する前に、引用された各パスの実際のソースを `read_file` してください。',
    },
    coverage: `\`references/coverage.json\` があれば、その内容ハッシュを鮮度の指標として扱ってください。ハッシュが
古い場合、ページはコードに遅れている可能性があります。handbook の文章をコード本文の根拠にしては
いけません — 逐語的な編集を出す前に、必ず実際のソースで確認してください。`,
    corrections: `## 訂正（Corrections）

handbook の記述が実際のソースと矛盾する場合（「handbook は X がファイル A にあると言うが、実際は B に
ある」）、報告してください。skill のルート（この SKILL.md と同じ階層 — planner が読み取り専用でマウント
する \`references/\` の下には決して置かない）にある \`corrections.jsonl\` に JSON を 1 行追記します。初回は
ファイルを作成してください。1 行につき 1 オブジェクトです：

\`\`\`json
${CORRECTION_EXAMPLE}
\`\`\`

\`file\` はリポジトリ相対のソースパス（必須）、\`page\` はその記述を載せていた references/ のページ、
\`claim\`/\`actual\` は矛盾の内容、\`notedAt\` は ISO タイムスタンプ — \`file\` 以外は任意です。
\`references/\` の下を自分で書き換えないでください：のちの resync が \`corrections.jsonl\` を読み、名指し
されたファイルだけを更新します。それまでは実際のソースを基準に作業を続けてください。`,
    noRegisters:
      '# 状態レジスタ\n\n_このコードベースではステージをまたぐ状態レジスタは特定されませんでした。_\n',
  },
  de: {
    header: (project) => `# ${project} Handbook — so wird es benutzt

Dieses Handbook ist ein **Ortsverzeichnis** der ${project}-Codebasis, keine Beschreibung des Codes.
Entscheide damit, WELCHE Dateien, Funktionen und welchen Zustand eine Änderung berühren muss — und lies
dann den echten Quellcode.`,
    steps: {
      overview: 'Lies `references/overview.md`, um die Form des Systems zu sehen.',
      index:
        'Navigiere über `references/index.md` — der Etappenindex ordnet jedem Subsystem seine Dateien zu.',
      stages: 'Öffne nur die relevanten Seiten `references/stages/<id>.md`.',
      registers:
        'Prüfe `references/registers.md` auf querschnittlichen Zustand — unbezahlbar bei weitreichenden Änderungen.',
      agent:
        'Für ein Symbol, eine Datei oder Aufrufer nicht raten, sondern die Faktentabellen grepen: `grep "^NAME\t" references/agent/symbols.tsv` liefert `Pfad:Startzeile-Endzeile`; `grep "\tNAME\t" references/agent/calls.tsv` liefert die Aufrufer. Alle Rezepte stehen in `references/agent/index.md`. Die Fundstellen stammen vom Parser; öffne die Datei und lies den Bereich, bevor du etwas änderst.',
      source:
        'Führe an jedem zitierten Pfad `read_file` auf den echten Quellcode aus, bevor du Änderungen vorschlägst oder vornimmst.',
    },
    coverage: `Wenn \`references/coverage.json\` existiert, behandle die Inhalts-Hashes als Frischesignale: ein
veralteter Hash heißt, die Seite kann dem Code hinterherhinken. Nimm den Fließtext des Handbooks NICHT
als Wahrheit für Codetext — bestätige immer am echten Quellcode, bevor du eine wörtliche Änderung
ausgibst.`,
    corrections: `## Korrekturen

Wenn eine Aussage des Handbooks dem echten Quellcode widerspricht ("das Handbook sagt, X liegt in Datei
A; tatsächlich liegt es in B"), melde es: hänge EINE Zeile JSON an \`corrections.jsonl\` im Wurzelverzeichnis
des Skills an (neben dieser SKILL.md — niemals unter \`references/\`, das Planer nur lesend einhängen).
Lege die Datei beim ersten Schreiben an. Ein Objekt pro Zeile:

\`\`\`json
${CORRECTION_EXAMPLE}
\`\`\`

\`file\` ist der repo-relative Quellpfad (erforderlich); \`page\` ist die references/-Seite, die die Aussage
trug; \`claim\`/\`actual\` benennen den Widerspruch; \`notedAt\` ist ein ISO-Zeitstempel — alle optional.
Bearbeite niemals selbst etwas unter \`references/\`: ein späterer resync verarbeitet \`corrections.jsonl\`
und frischt genau die genannten Dateien auf. Arbeite weiter am echten Quellcode.`,
    noRegisters:
      '# Zustandsregister\n\n_Für diese Codebasis wurden keine etappenübergreifenden Zustandsregister ermittelt._\n',
  },
};

function skillMd(name: string, project: string, lang: NarrateLang, withAgentPages: boolean): string {
  const copy = SKILL_COPY[lang];
  const steps = [copy.steps.overview, copy.steps.index, copy.steps.stages, copy.steps.registers];
  if (withAgentPages) steps.push(copy.steps.agent);
  steps.push(copy.steps.source);
  const protocol = steps.map((step, i) => `${i + 1}. ${step}`).join('\n');
  // The frontmatter is intentionally NOT localized: agent runtimes route on
  // the description ("Use when …" / "Do not use …" is a validated contract),
  // so it must stay English even when the body is Chinese.
  return `---
name: ${name}-handbook
description: Navigate the ${project} codebase by behavior and source location. Use when planning, implementing, debugging, or reviewing ${project} work that is unfamiliar, spans multiple files, or may affect cross-cutting state. Do not use for tasks unrelated to ${project} or isolated edits where the exact file is already known and no cross-cutting impact is plausible.
---

${copy.header(project)}

${protocol}

${copy.coverage}

${copy.corrections}
`;
}

/** The two locator pages of a rendered agent site that ship with the skill. */
/**
 * The agent artifact's files, shipped as a set.
 *
 * `index.md` is the entry point and the three tables are what it routes to, so
 * they travel together: SKILL.md must never route to a file that does not
 * exist. The stage pages ship too — they are the second hop — but their absence
 * is not fatal, so they are copied opportunistically rather than gated on.
 *
 * Previously this list was `how_to_use.md` + `disambiguation.md`, which meant
 * the entire agent index and every stage page were generated and then never
 * delivered through the skill — the product's primary channel.
 */
const AGENT_LOCATOR_PAGES = ['index.md', 'symbols.tsv', 'files.tsv', 'calls.tsv'];

/** Every top-level entry a handbook skill build writes into `--out`. */
const OUR_TOP_LEVEL = new Set(['SKILL.md', 'references', 'corrections.jsonl']);
/** Filesystem litter that is nobody's data — never a reason to refuse a rebuild. */
const IGNORABLE_ENTRIES = new Set(['.DS_Store', 'Thumbs.db']);

/**
 * Resolve a repo-relative POSIX path inside `root`, or `undefined` when it
 * leaves — the guard that keeps a model-authored assignment path from making
 * the builder read (and publish the hash of) a file off-tree.
 */
function insideRoot(root: string, relPath: string): string | undefined {
  if (isAbsoluteAnyPlatform(relPath) || relPath.includes('\\')) return undefined;
  const full = resolve(root, normalize(relPath));
  return full === root || full.startsWith(root + sep) ? full : undefined;
}

/**
 * Stage pages to ship, as (source path, destination file name) pairs. A nested
 * `stages/` directory wins; otherwise every root-level `.md` that is not a
 * known top-level page — stage ids are arbitrary (LLM- or user-authored), so a
 * name-shape filter would silently drop pages. The flat scan does NOT recurse:
 * sub-sites (agent/, html/) carry their own copies of the stage pages.
 */
function stagePageSources(handbookDir: string): Array<{ from: string; name: string }> {
  if (fileExists(join(handbookDir, 'stages'))) {
    return listFilesRecursive(join(handbookDir, 'stages'), { extensions: ['.md'] }).map((page) => ({
      from: join(handbookDir, 'stages', page),
      name: basename(page),
    }));
  }
  return listFilesRecursive(handbookDir, { extensions: ['.md'] })
    .filter((f) => !f.includes('/') && !NON_STAGE_PAGES.has(basename(f).toLowerCase()))
    .map((page) => ({ from: join(handbookDir, page), name: basename(page) }));
}

export function buildSkill(options: BuildSkillOptions): BuildSkillResult {
  const { handbookDir, outDir } = options;
  const project = options.project ?? options.name;
  const lang = options.lang ?? PIPELINE_DEFAULTS.narrateLang;
  if (!fileExists(join(handbookDir, 'index.md'))) {
    throw new Error(`${handbookDir} is not a rendered handbook (missing index.md)`);
  }
  // The build starts by wiping outDir. If outDir IS the handbook (or the handbook
  // sits inside it), that clean would destroy the very source we are packaging —
  // and then silently produce a broken, empty skill. Refuse both up front.
  const outAbs = resolve(outDir);
  const handbookAbs = resolve(handbookDir);
  if (outAbs === handbookAbs || handbookAbs.startsWith(outAbs + sep)) {
    throw new Error(
      `outDir must not be the handbook directory or an ancestor of it (outDir=${outAbs}, handbookDir=${handbookAbs}) — packaging would delete the source`,
    );
  }
  // The clean below is `rm -rf outDir`, and `out` is reachable from a committed
  // handbook.config.yaml or a HANDBOOK_SKILL_OUT inherited from a project .env
  // — so a stale value, or `--out .`, deletes an unrelated tree with no
  // confirmation and no dry-run.
  //
  // A SKILL.md on its own is NOT proof this build produced the directory: every
  // hand-written agent skill has one too, sitting next to the scripts, assets
  // and git history that months of somebody's work live in. So both facts must
  // hold — the marker file is present AND nothing that this build never writes
  // is — because `rm -rf` cannot ask forgiveness afterwards.
  if (fileExists(outAbs)) {
    const existing = readdirSync(outAbs).filter((entry) => !IGNORABLE_ENTRIES.has(entry));
    const foreign = existing.filter((entry) => !OUR_TOP_LEVEL.has(entry));
    const oursToReplace =
      existing.length === 0 || (existsSync(join(outAbs, 'SKILL.md')) && foreign.length === 0);
    if (!oursToReplace) {
      const why =
        foreign.length > 0
          ? `it holds ${foreign
              .slice(0, 5)
              .map((entry) => JSON.stringify(entry))
              .join(', ')}, which \`handbook skill\` never writes`
          : 'it is not empty and holds no SKILL.md, so it was not built by `handbook skill`';
      throw new Error(
        `refusing to overwrite ${outAbs}: ${why}. Packaging starts by deleting the whole directory — ` +
          `pass --out an empty or previously-built path.`,
      );
    }
  }
  // Both checks below run BEFORE the destructive clean: refusing after it would
  // have already destroyed the directory the refusal is meant to protect.
  const stagePages = stagePageSources(handbookDir);
  // The nested layout is flattened onto `references/stages/<basename>`, so two
  // pages differing only by directory land on one path and the second silently
  // overwrites the first — a page dropped without a word.
  const pageByName = new Map<string, string>();
  for (const page of stagePages) {
    const clash = pageByName.get(page.name);
    if (clash) {
      throw new Error(
        `two stage pages share the same file name and would both flatten onto ` +
          `references/stages/${page.name}: ${clash} and ${page.from} — rename one`,
      );
    }
    pageByName.set(page.name, page.from);
  }
  const coverageRoot = options.coverage?.sourceRoot ? resolve(options.coverage.sourceRoot) : undefined;
  if (options.coverage && coverageRoot) {
    const escaping = Object.keys(options.coverage.assignment.fileStage).filter(
      (file) => insideRoot(coverageRoot, file) === undefined,
    );
    if (escaping.length > 0) {
      throw new Error(
        `assignment lists ${escaping.length} path(s) that escape the source root ` +
          `(${escaping.slice(0, 5).join(', ')}) — refusing to hash files off-tree`,
      );
    }
  }
  // Agent locator pages ship only as a pair: SKILL.md must never route to a
  // file that does not exist, and half a locator is what the validator warns on.
  const agentSite = options.agentDir;
  const agentDir =
    agentSite && AGENT_LOCATOR_PAGES.every((p) => fileExists(join(agentSite, p))) ? agentSite : undefined;
  // corrections.jsonl is AGENT-owned feedback (see the SKILL.md protocol):
  // the builder never creates it, and a rebuild into the same outDir must not
  // wipe records that have not been resynced yet — stash it across the clean.
  const correctionsPath = join(outDir, 'corrections.jsonl');
  const pendingCorrections = fileExists(correctionsPath) ? readFileSync(correctionsPath, 'utf8') : undefined;
  rmSync(outDir, { recursive: true, force: true });
  const referencesDir = join(outDir, 'references');
  const stagesDir = join(referencesDir, 'stages');
  ensureDir(stagesDir);
  if (pendingCorrections !== undefined) writeFileAtomic(correctionsPath, pendingCorrections);

  writeFileAtomic(join(outDir, 'SKILL.md'), skillMd(options.name, project, lang, agentDir !== undefined));

  const references: string[] = [];
  if (agentDir) {
    const agentOut = join(referencesDir, 'agent');
    ensureDir(agentOut);
    for (const page of AGENT_LOCATOR_PAGES) {
      copyFileSync(join(agentDir, page), join(agentOut, page));
      references.push(`agent/${page}`);
    }
    // The second hop. Opportunistic: a handbook with no content-bearing stage
    // produces none, and that is not a reason to ship no index.
    const stageSrc = join(agentDir, 'stages');
    if (fileExists(stageSrc)) {
      const stageOut = join(agentOut, 'stages');
      ensureDir(stageOut);
      for (const page of readdirSync(stageSrc).sort()) {
        if (!page.endsWith('.md')) continue;
        copyFileSync(join(stageSrc, page), join(stageOut, page));
        references.push(`agent/stages/${page}`);
      }
    }
  }
  const copyMap: Array<[string, string[]]> = [
    ['overview.md', ['overview.md']],
    ['index.md', ['index.md']],
    ['registers.md', ['registers.md', 'register.md']],
  ];
  for (const [dest, candidates] of copyMap) {
    const source = candidates.map((c) => join(handbookDir, c)).find(fileExists);
    if (source) {
      copyFileSync(source, join(referencesDir, dest));
      references.push(dest);
    }
  }
  // A handbook with zero registers renders no register page; the skill still
  // ships one so the reference layout (and the validator contract) is stable.
  if (!references.includes('registers.md')) {
    writeFileAtomic(join(referencesDir, 'registers.md'), SKILL_COPY[lang].noRegisters);
    references.push('registers.md');
  }

  for (const page of stagePages) copyFileSync(page.from, join(stagesDir, page.name));

  if (options.coverage) {
    const { assignment } = options.coverage;
    const files = Object.entries(assignment.fileStage)
      .map(([file, entry]) => {
        let sha = '';
        // `insideRoot` cannot be undefined here — every key was checked before
        // the clean — but reading its result is what keeps that true if the
        // check above is ever moved.
        const full = coverageRoot ? insideRoot(coverageRoot, file) : undefined;
        if (full) {
          try {
            sha = sha256Hex(readFileSync(full));
          } catch {
            sha = '';
          }
        }
        return { path: file, stage: entry.stage, sha256: sha };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
    writeJsonFile(join(referencesDir, 'coverage.json'), {
      schemaVersion: 1,
      summary: {
        eligibleFiles: files.length,
        stages: Object.fromEntries(
          Object.entries(assignment.buckets).map(([sid, bucket]) => [sid, bucket.length]),
        ),
      },
      files,
    });
    references.push('coverage.json');
  }

  return { outDir, nStagePages: stagePages.length, references };
}
