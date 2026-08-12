import type { Locale } from './i18n';

/**
 * Every word the landing page renders, per locale.
 *
 * Kept SEPARATE from `ui-strings.ts` on purpose. That table is chrome — the
 * labels Fumadocs' own components read, plus our nav — and its value is that it
 * is small enough to check at a glance. This one is page copy: whole paragraphs,
 * only ever read by `app/[lang]/(home)/page.tsx`. Merging them would turn one
 * small obvious table and one page-shaped table into a single large unobvious
 * one, where a missing nav label hides between two marketing sentences.
 *
 * One table rather than eight files for the same reason `ui-strings.ts` is one
 * table: a missing key must be a type error, and eight sibling files make it a
 * silent English fallback instead. The compiler checks the shape; a reviewer
 * comparing eight locales of the same sentence only has to scroll.
 *
 * What is NOT in here, deliberately:
 *
 *   - Command names (`analyze`, `generate`, `render`, `skill`, `plan`, `apply`,
 *     `resync`), `tree-sitter`, `llms.txt`, `llms-full.txt`, `SKILL.md`,
 *     `references/`, `MIT`, `LLM`, `file://`, `.html` — identifiers, not words.
 *     Translating one makes a copy-pasteable name wrong.
 *   - The shell snippet's two command lines. Its comment IS translated: the
 *     comment is prose a reader is meant to read, the commands are things they
 *     are meant to paste.
 *   - The three strings SEO owns (`tagline`, `description`, `shortDescription`
 *     in `lib/shared.ts`). The page's `generateMetadata` gets them from
 *     `siteMetadata(lang)`; duplicating them here would let the `<h1>` and the
 *     `<title>` drift apart in seven languages at once.
 *
 * Terminology follows the already-translated pages under `content/docs/**` and
 * the localised diagrams in `assets/*.<locale>.svg`, which are what a reader
 * sees immediately above and below this copy. Where those two disagree, the
 * prose pages win — the homepage links into them, so a reader crossing that
 * link must not meet a second vocabulary for the same idea.
 */
export interface HomeStrings {
  /** Hero. `MIT` and the separators stay in the component. */
  badgeLanguages: string;
  badgeEndpoint: string;
  /**
   * The `<h1>`, split where the gradient starts. Both halves are one sentence.
   *
   * `headline` carries its own trailing separator — a space in the locales whose
   * script uses one, nothing in Chinese and Japanese, which do not put a space
   * between a clause and the next. The component deliberately adds none, because
   * a hard-coded `{' '}` there is a visible typo in two of the eight languages.
   */
  headline: string;
  headlineAccent: string;
  /**
   * The hero paragraph, split around the one emphasised word.
   *
   * Three fields rather than one, because the emphasis is on the noun — and that
   * noun does not sit in the same place in every language. A single string with
   * markup baked in would force English word order on all eight; a lead/word/rest
   * split lets the split point move with the word.
   */
  heroLead: string;
  heroEmphasis: string;
  heroRest: string;
  ctaDemo: string;
  ctaDocs: string;
  /** The `#` comment inside the snippet. The commands themselves are fixed. */
  snippetComment: string;
  snippetNote: string;

  /** The pipeline section. */
  pipelineTitle: string;
  pipelineLede: string;
  /** The chip on a deterministic step. Its counterpart, `LLM`, is a name. */
  noLlm: string;
  /** Keyed by command, so reordering the steps cannot silently mismatch them. */
  steps: Record<'analyze' | 'generate' | 'render' | 'skill' | 'plan' | 'apply' | 'resync', string>;
  pipelineMore: string;
  /** Alt text is read aloud, so it is copy — not a comment. */
  pipelineDiagramAlt: string;

  /** The trust section. */
  pillarsTitle: string;
  pillars: Record<'parser' | 'prose' | 'routing' | 'applying' | 'incremental', Pillar>;
  limitsTitle: string;
  limitsBody: string;
  limitsLink: string;

  /** The outputs section. `llms` has no title: both file names are identifiers. */
  formatsTitle: string;
  formatsLede: string;
  formats: Record<'markdown' | 'html' | 'single' | 'agent' | 'skill', Format> & { llms: { body: string } };

  /** The closing section. `closingBefore` wraps `handbook analyze` on the left. */
  closingTitle: string;
  closingBefore: string;
  closingAfter: string;
  ctaInstall: string;
  ctaCli: string;
}

interface Pillar {
  title: string;
  body: string;
}

interface Format {
  title: string;
  body: string;
}

export const HOME: Record<Locale, HomeStrings> = {
  en: {
    badgeLanguages: '18 LANGUAGES',
    badgeEndpoint: 'ANY OPENAI-COMPATIBLE ENDPOINT',
    headline: 'One codebase in. ',
    headlineAccent: 'Two handbooks out — one your team reads, one your agent routes with.',
    heroLead:
      'Your coding agent greps for a symbol, finds three of the seven places that matter, and ships a half-change. That is a ',
    heroEmphasis: 'routing',
    heroRest: ' failure, not a reasoning one. Handbook gives it the map.',
    ctaDemo: 'Run the offline demo',
    ctaDocs: 'Read the docs',
    snippetComment: '# full pipeline, offline, no API key, ~30s',
    snippetNote: 'Bundled sample project, bundled mock LLM. Zero tokens spent.',
    pipelineTitle: 'Seven commands, one loop',
    pipelineLede:
      'Teal steps are deterministic — no LLM, no network, free to re-run in CI. Amber steps talk to your endpoint, and cache what they learn.',
    noLlm: 'NO LLM',
    steps: {
      analyze: 'Parse every file into a typed call graph.',
      generate: 'Cards, stages, prose, cross-stage state.',
      render: 'Markdown, HTML, agent index, llms.txt.',
      skill: 'Package it for your coding agent.',
      plan: 'Localize a change into byte-exact edits.',
      apply: 'All-or-nothing patch, with rollback.',
      resync: 'Roll the handbook forward. No rebuild.',
    },
    pipelineMore: 'How each phase works',
    pipelineDiagramAlt:
      'The Handbook pipeline: analyze, generate, render, skill, plan, apply, and the resync feedback loop',
    pillarsTitle: 'Why you can trust what you read',
    pillars: {
      parser: {
        title: 'Facts come from a parser',
        body: 'tree-sitter builds the call graph: functions, resolved edges, boundary calls, and the calls it could not resolve — quarantined, never guessed. This layer never touches an LLM, so it is the same every run.',
      },
      prose: {
        title: 'Prose sits on top, and says so',
        body: 'An LLM writes what a file is for and how a subsystem hangs together, always anchored to the graph. Where it fails, the structure still ships with an empty description. A missing sentence beats an invented one.',
      },
      routing: {
        title: 'Built for routing, not reading',
        body: 'The output answers “which files, functions and state does this change touch?” — including the scattered, non-obvious ones a text search misses. Then the planner reads the real source at every address.',
      },
      applying: {
        title: 'Applying is boring on purpose',
        body: 'Anchors must match byte-exactly and uniquely. Everything is verified before anything is written. Every touched file is backed up with its pre-patch hash, so rollback can prove what it is restoring.',
      },
      incremental: {
        title: 'It stays current incrementally',
        body: 'Resync diffs the old graph against the new one and regenerates only what actually changed. Touch three files, pay for three files. Documentation stops rotting because updating it stopped being expensive.',
      },
    },
    limitsTitle: 'And it discloses its own limits',
    limitsBody:
      'Languages read by the config-driven analyzer are named in the overview, so “best-effort call relations” can never be read as “exact”.',
    limitsLink: 'Analysis fidelity',
    formatsTitle: 'One run. Six shipping formats.',
    formatsLede:
      'Generation is the expensive part and it happens once. Everything below is a deterministic re-render you can run on every commit.',
    formats: {
      markdown: {
        title: 'Markdown handbook',
        body: 'overview · index · one page per stage · state-register table',
      },
      html: {
        title: 'Multi-page HTML site',
        body: 'sticky TOC, breadcrumbs, theme toggle — works over file://',
      },
      single: {
        title: 'One self-contained page',
        body: 'a single .html you can email or attach to a ticket',
      },
      agent: {
        title: 'Agent locator index',
        body: 'duty · entry concepts · state · exemplars · co-change hints',
      },
      llms: { body: 'the llms.txt convention, plus the whole thing flattened' },
      skill: {
        title: 'Agent SKILL package',
        body: 'SKILL.md + references/ + a content hash per file',
      },
    },
    closingTitle: 'Start with the free command',
    closingBefore: '',
    closingAfter:
      ' never needs an API key. Run it on your repo, look at the file and function counts, and decide whether the rest is worth a single token.',
    ctaInstall: 'Install',
    ctaCli: 'CLI reference',
  },

  // 智能体, not 代理, for "agent": 代理 also means "proxy" and this very page
  // talks about endpoints and internal proxies, and both localised diagrams on
  // the page already say 智能体.
  zh: {
    badgeLanguages: '18 种语言',
    badgeEndpoint: '任意 OpenAI 兼容端点',
    headline: '一个代码库进去，',
    headlineAccent: '两本手册出来——一本给你的团队读，一本给你的智能体定位。',
    heroLead:
      '你的编码智能体 grep 一个符号，在真正相关的七处里找到三处，然后交付了一个只改了一半的改动。这不是推理出了问题，而是',
    heroEmphasis: '路由',
    heroRest: '出了问题。Handbook 把地图交给它。',
    ctaDemo: '运行离线演示',
    ctaDocs: '阅读文档',
    snippetComment: '# 完整流水线，离线运行，无需 API key，约 30 秒',
    snippetNote: '内置示例项目，内置 mock LLM。零 token 花费。',
    pipelineTitle: '七个命令，一个闭环',
    pipelineLede:
      '青色步骤是确定性的——不用 LLM，不联网，在 CI 里想重跑多少次都不花钱。琥珀色步骤会访问你的端点，并把学到的东西缓存下来。',
    noLlm: '无 LLM',
    steps: {
      analyze: '把每个文件解析成一张带类型的调用图。',
      generate: '卡片、阶段、叙述文字，以及跨阶段状态。',
      render: 'Markdown、HTML、智能体索引、llms.txt。',
      skill: '打包给你的编码智能体。',
      plan: '把一次改动定位成逐字节精确的编辑。',
      apply: '全有或全无地打补丁，可回滚。',
      resync: '把手册向前滚动。无需重建。',
    },
    pipelineMore: '每个阶段是怎么工作的',
    pipelineDiagramAlt:
      'Handbook 流水线：analyze、generate、render、skill、plan、apply，以及 resync 反馈回路',
    pillarsTitle: '为什么你可以信任读到的内容',
    pillars: {
      parser: {
        title: '事实来自解析器',
        body: 'tree-sitter 构建调用图：函数、已解析的边、边界调用，以及它无法解析的调用——后者被隔离出来，绝不靠猜。这一层从不接触 LLM，所以每次运行都一模一样。',
      },
      prose: {
        title: '文字叠在上面，并且明说',
        body: '一个文件是干什么的、一个子系统如何组织，由 LLM 来写，并且始终锚定在调用图上。写不出来的地方，结构照样产出，只是描述为空。宁可缺一句话，也不要编一句话。',
      },
      routing: {
        title: '为路由而建，不是为阅读而建',
        body: '产出回答的是“这次改动要碰哪些文件、函数和状态？”——包括那些分散的、不显眼的、文本搜索找不到的地方。随后规划器会在它找到的每个地址上阅读真实源码。',
      },
      applying: {
        title: '打补丁刻意做得很无聊',
        body: '锚点必须逐字节精确且唯一匹配。在写入任何东西之前，一切都已校验完毕。每个被触碰的文件都会连同打补丁前的哈希一起备份，所以回滚能证明自己在还原什么。',
      },
      incremental: {
        title: '它以增量方式保持新鲜',
        body: 'resync 对比新旧调用图，只重新生成真正变化的部分。改了三个文件，就只为三个文件付费。文档不再腐烂，是因为更新它不再昂贵。',
      },
    },
    limitsTitle: '而且它会披露自己的局限',
    limitsBody:
      '由配置驱动分析器读取的语言会在总览中被点名，这样“尽力而为的调用关系”就绝不会被误读成“精确”。',
    limitsLink: '分析保真度',
    formatsTitle: '一次运行。六种可交付的格式。',
    formatsLede:
      '生成是最贵的一步，而它只发生一次。下面的一切都是确定性的重渲染，你可以在每次提交时都跑一遍。',
    formats: {
      markdown: { title: 'Markdown 手册', body: '总览 · 索引 · 每个阶段一页 · 状态寄存器表' },
      html: { title: '多页 HTML 站点', body: '吸附式目录、面包屑、主题切换——可直接通过 file:// 打开' },
      single: { title: '一个自包含页面', body: '单个 .html，可以用邮件发出去，或者附到工单里' },
      agent: { title: '智能体定位索引', body: '职责 · 入口概念 · 状态 · 范例 · 共同变更提示' },
      llms: { body: 'llms.txt 约定，外加整本手册的扁平化全文' },
      skill: { title: '智能体 SKILL 包', body: 'SKILL.md + references/ + 每个文件一个内容哈希' },
    },
    closingTitle: '从那个免费的命令开始',
    closingBefore: '',
    closingAfter:
      ' 从不需要 API key。在你自己的仓库上跑一遍，看看文件数和函数数，再决定后面的部分值不值得花一个 token。',
    ctaInstall: '安装',
    ctaCli: 'CLI 参考',
  },

  // Technical nouns stay in Latin script, as they do on every Hindi page here:
  // a Hindi developer reads `call graph` and `routing`, and a coined Devanagari
  // equivalent would be less clear, not more Hindi.
  hi: {
    badgeLanguages: '18 भाषाएँ',
    badgeEndpoint: 'कोई भी OpenAI-compatible endpoint',
    headline: 'एक codebase अंदर। ',
    headlineAccent: 'दो handbooks बाहर — एक आपकी टीम पढ़ती है, एक से आपका agent रास्ता निकालता है।',
    heroLead:
      'आपका coding agent किसी symbol को grep करता है, जो सात जगहें मायने रखती हैं उनमें से तीन ढूँढता है, और आधा-अधूरा बदलाव ship कर देता है। यह reasoning की विफलता नहीं, ',
    heroEmphasis: 'routing',
    heroRest: ' की विफलता है। Handbook उसे नक़्शा थमा देता है।',
    ctaDemo: 'Offline demo चलाएँ',
    ctaDocs: 'Documentation पढ़ें',
    snippetComment: '# पूरी pipeline, offline, बिना API key, ~30 सेकंड',
    snippetNote: 'साथ में आया sample project, साथ में आया mock LLM। ख़र्च हुए tokens: शून्य।',
    pipelineTitle: 'सात commands, एक loop',
    pipelineLede:
      'टील रंग के steps deterministic हैं — न LLM, न network, CI में जितनी बार चाहें मुफ़्त चलाइए। एम्बर रंग के steps आपके endpoint से बात करते हैं, और जो सीखते हैं उसे cache कर लेते हैं।',
    noLlm: 'बिना LLM',
    steps: {
      analyze: 'हर file को typed call graph में parse करता है।',
      generate: 'Cards, stages, prose, और cross-stage state।',
      render: 'Markdown, HTML, agent index, llms.txt।',
      skill: 'आपके coding agent के लिए इसे package करता है।',
      plan: 'एक बदलाव को byte-exact edits में बदल देता है।',
      apply: 'सब-या-कुछ-नहीं patch, rollback के साथ।',
      resync: 'Handbook को आगे बढ़ाता है। कोई rebuild नहीं।',
    },
    pipelineMore: 'हर phase कैसे काम करता है',
    pipelineDiagramAlt:
      'Handbook pipeline: analyze, generate, render, skill, plan, apply, और resync का feedback loop',
    pillarsTitle: 'आप जो पढ़ते हैं उस पर भरोसा क्यों कर सकते हैं',
    pillars: {
      parser: {
        title: 'Facts parser से आते हैं',
        body: 'tree-sitter call graph बनाता है: functions, resolved edges, बाउंड्री कॉल, और वे calls जो resolve नहीं हो सकीं — वे quarantine में जाती हैं, उनके बारे में कभी अंदाज़ा नहीं लगाया जाता। यह layer कभी LLM को नहीं छूती, इसलिए हर run में एक जैसी रहती है।',
      },
      prose: {
        title: 'Prose ऊपर की परत है, और यह कहती भी है',
        body: 'कोई file किसलिए है और कोई subsystem आपस में कैसे जुड़ा है, यह LLM लिखता है — हमेशा graph से बँधा हुआ। जहाँ वह विफल होता है, वहाँ भी structure ship होता है, बस description ख़ाली रहती है। गढ़े हुए वाक्य से छूटा हुआ वाक्य बेहतर है।',
      },
      routing: {
        title: 'Routing के लिए बना है, पढ़ने के लिए नहीं',
        body: 'Output इस सवाल का जवाब देता है — “इस बदलाव को किन files, functions और state को छूना पड़ेगा?” — उन बिखरे और ग़ैर-ज़ाहिर हिस्सों समेत जो text search से छूट जाते हैं। इसके बाद planner हर address पर असली source पढ़ता है।',
      },
      applying: {
        title: 'Apply करना जान-बूझकर उबाऊ है',
        body: 'Anchor का match byte-exact और अनोखा होना ज़रूरी है। कुछ भी लिखे जाने से पहले सब कुछ verify हो जाता है। छुई गई हर file का backup, patch से पहले के hash के साथ बनता है — ताकि rollback साबित कर सके कि वह क्या बहाल कर रहा है।',
      },
      incremental: {
        title: 'यह incremental ढंग से current रहता है',
        body: 'Resync पुराने graph का नए से diff करता है और सिर्फ़ वही regenerate करता है जो वाक़ई बदला। तीन files छुइए, तीन files की क़ीमत चुकाइए। Documentation सड़ना बंद कर देता है, क्योंकि उसे update करना महँगा रहा ही नहीं।',
      },
    },
    limitsTitle: 'और यह अपनी सीमाएँ भी बता देता है',
    limitsBody:
      'Config-driven analyzer से पढ़ी गई भाषाओं का overview में नाम लिया जाता है, ताकि “best-effort call relations” को कभी “exact” न पढ़ लिया जाए।',
    limitsLink: 'Analysis fidelity',
    formatsTitle: 'एक run। छह shipping formats।',
    formatsLede:
      'Generation ही महँगा हिस्सा है, और वह एक ही बार होता है। नीचे का सब कुछ deterministic re-render है, जिसे आप हर commit पर चला सकते हैं।',
    formats: {
      markdown: {
        title: 'Markdown handbook',
        body: 'overview · index · हर stage का एक page · state-register table',
      },
      html: {
        title: 'Multi-page HTML site',
        body: 'sticky TOC, breadcrumbs, theme toggle — file:// पर भी चलती है',
      },
      single: {
        title: 'एक self-contained page',
        body: 'एक अकेली .html, जिसे email करें या ticket में attach कर दें',
      },
      agent: {
        title: 'Agent locator index',
        body: 'duty · entry concepts · state · exemplars · co-change hints',
      },
      llms: { body: 'llms.txt convention, और साथ में पूरी handbook flattened' },
      skill: {
        title: 'Agent SKILL package',
        body: 'SKILL.md + references/ + हर file का एक content hash',
      },
    },
    closingTitle: 'उस मुफ़्त command से शुरुआत कीजिए',
    closingBefore: '',
    closingAfter:
      ' को कभी API key की ज़रूरत नहीं पड़ती। इसे अपनी repo पर चलाइए, files और functions की गिनती देखिए, और तय कीजिए कि बाक़ी हिस्सा एक token ख़र्च करने लायक़ है या नहीं।',
    ctaInstall: 'Install करें',
    ctaCli: 'CLI संदर्भ',
  },

  es: {
    badgeLanguages: '18 LENGUAJES',
    badgeEndpoint: 'CUALQUIER ENDPOINT COMPATIBLE CON OPENAI',
    headline: 'Entra una base de código. ',
    headlineAccent: 'Salen dos handbooks: uno que lee tu equipo, otro con el que se orienta tu agente.',
    heroLead:
      'Tu agente de código hace grep de un símbolo, encuentra tres de los siete lugares que importan y entrega media modificación. Eso no es un fallo de razonamiento: es un fallo de ',
    heroEmphasis: 'enrutamiento',
    heroRest: '. Handbook le da el mapa.',
    ctaDemo: 'Ejecuta la demo sin red',
    ctaDocs: 'Lee la documentación',
    snippetComment: '# pipeline completo, sin red, sin clave de API, ~30 s',
    snippetNote: 'Proyecto de ejemplo incluido, LLM simulado incluido. Cero tokens gastados.',
    pipelineTitle: 'Siete comandos, un solo bucle',
    pipelineLede:
      'Los pasos verde azulado son deterministas: sin LLM, sin red, se vuelven a ejecutar gratis en CI. Los pasos ámbar hablan con tu endpoint y cachean lo que aprenden.',
    noLlm: 'SIN LLM',
    steps: {
      analyze: 'Parsea cada archivo en un grafo de llamadas tipado.',
      generate: 'Fichas, etapas, prosa, estado entre etapas.',
      render: 'Markdown, HTML, índice para agentes, llms.txt.',
      skill: 'Lo empaqueta para tu agente de código.',
      plan: 'Localiza un cambio en ediciones exactas al byte.',
      apply: 'Parche todo o nada, con rollback.',
      resync: 'Adelanta el handbook. Sin reconstruirlo.',
    },
    pipelineMore: 'Cómo funciona cada fase',
    pipelineDiagramAlt:
      'El pipeline de Handbook: analyze, generate, render, skill, plan, apply y el bucle de realimentación de resync',
    pillarsTitle: 'Por qué puedes confiar en lo que lees',
    pillars: {
      parser: {
        title: 'Los hechos vienen de un parser',
        body: 'tree-sitter construye el grafo de llamadas: funciones, aristas resueltas, llamadas de frontera y las llamadas que no pudo resolver — puestas en cuarentena, nunca adivinadas. Esta capa nunca toca un LLM, así que es idéntica en cada ejecución.',
      },
      prose: {
        title: 'La prosa va encima, y lo dice',
        body: 'Un LLM escribe para qué sirve un archivo y cómo se articula un subsistema, siempre anclado al grafo. Donde falla, la estructura se publica igualmente con una descripción vacía. Una frase ausente es mejor que una inventada.',
      },
      routing: {
        title: 'Hecho para enrutar, no para leer',
        body: 'La salida responde «¿qué archivos, funciones y estado tiene que tocar este cambio?» — incluidos los dispersos y poco obvios que una búsqueda de texto no ve. Después el planner lee el código fuente real en cada dirección.',
      },
      applying: {
        title: 'Aplicar es aburrido a propósito',
        body: 'Las anclas deben coincidir exactas al byte y una sola vez. Todo se verifica antes de escribir nada. Cada archivo tocado se respalda con su hash previo al parche, para que el rollback pueda demostrar qué está restaurando.',
      },
      incremental: {
        title: 'Se mantiene al día de forma incremental',
        body: 'Resync compara el grafo viejo con el nuevo y regenera solo lo que cambió de verdad. Toca tres archivos, paga por tres archivos. La documentación deja de pudrirse porque actualizarla dejó de ser caro.',
      },
    },
    limitsTitle: 'Y divulga sus propios límites',
    limitsBody:
      'Los lenguajes que lee el analizador guiado por configuración se nombran en la visión general, para que «relaciones de llamada best-effort» nunca pueda leerse como «exactas».',
    limitsLink: 'Fidelidad del análisis',
    formatsTitle: 'Una ejecución. Seis formatos.',
    formatsLede:
      'La generación es la parte cara y ocurre una vez. Todo lo de abajo es un re-render determinista que puedes ejecutar en cada commit.',
    formats: {
      markdown: {
        title: 'Handbook en Markdown',
        body: 'visión general · índice · una página por etapa · tabla de registros de estado',
      },
      html: {
        title: 'Sitio HTML multipágina',
        body: 'TOC fijo, migas de pan, selector de tema — funciona sobre file://',
      },
      single: {
        title: 'Una página autocontenida',
        body: 'un único .html que puedes enviar por correo o adjuntar a un ticket',
      },
      agent: {
        title: 'Índice localizador para agentes',
        body: 'deber · conceptos de entrada · estado · ejemplares · co-cambios',
      },
      llms: { body: 'la convención llms.txt, más todo el handbook aplanado' },
      skill: {
        title: 'Paquete SKILL de agente',
        body: 'SKILL.md + references/ + un hash de contenido por archivo',
      },
    },
    closingTitle: 'Empieza por el comando gratuito',
    closingBefore: '',
    closingAfter:
      ' nunca necesita una clave de API. Ejecútalo sobre tu repo, mira los recuentos de archivos y funciones, y decide si el resto merece un solo token.',
    ctaInstall: 'Instalar',
    ctaCli: 'Referencia de CLI',
  },

  pt: {
    badgeLanguages: '18 LINGUAGENS',
    badgeEndpoint: 'QUALQUER ENDPOINT COMPATÍVEL COM OPENAI',
    headline: 'Entra uma base de código. ',
    headlineAccent: 'Saem dois handbooks: um que a sua equipe lê, outro pelo qual o seu agente se orienta.',
    heroLead:
      'Seu agente de codificação faz grep de um símbolo, encontra três dos sete lugares que importam e entrega meia mudança. Isso não é falha de raciocínio: é falha de ',
    heroEmphasis: 'roteamento',
    heroRest: '. O Handbook dá a ele o mapa.',
    ctaDemo: 'Rode a demo offline',
    ctaDocs: 'Leia a documentação',
    snippetComment: '# pipeline inteiro, offline, sem chave de API, ~30 s',
    snippetNote: 'Projeto de exemplo embutido, LLM simulado embutido. Zero tokens gastos.',
    pipelineTitle: 'Sete comandos, um só ciclo',
    pipelineLede:
      'Os passos turquesa são determinísticos — sem LLM, sem rede, dá para reexecutar de graça na CI. Os passos âmbar falam com o seu endpoint e guardam em cache o que aprendem.',
    noLlm: 'SEM LLM',
    steps: {
      analyze: 'Analisa cada arquivo num grafo de chamadas tipado.',
      generate: 'Fichas, etapas, prosa, estado entre etapas.',
      render: 'Markdown, HTML, índice para agentes, llms.txt.',
      skill: 'Empacota tudo para o seu agente de codificação.',
      plan: 'Localiza uma mudança em edições exatas ao byte.',
      apply: 'Patch tudo-ou-nada, com rollback.',
      resync: 'Avança o handbook. Sem reconstruir.',
    },
    pipelineMore: 'Como cada fase funciona',
    pipelineDiagramAlt:
      'O pipeline do Handbook: analyze, generate, render, skill, plan, apply e o laço de realimentação do resync',
    pillarsTitle: 'Por que você pode confiar no que lê',
    pillars: {
      parser: {
        title: 'Os fatos vêm de um parser',
        body: 'O tree-sitter constrói o grafo de chamadas: funções, arestas resolvidas, chamadas de borda e as chamadas que ele não conseguiu resolver — postas em quarentena, nunca adivinhadas. Essa camada nunca toca um LLM, então é a mesma em toda execução.',
      },
      prose: {
        title: 'A prosa fica por cima, e diz isso',
        body: 'Um LLM escreve para que serve um arquivo e como um subsistema se encaixa, sempre ancorado no grafo. Onde falha, a estrutura ainda é entregue — com uma descrição vazia. Uma frase ausente é melhor do que uma inventada.',
      },
      routing: {
        title: 'Feito para rotear, não para ler',
        body: 'A saída responde “quais arquivos, funções e estados esta mudança precisa tocar?” — inclusive os espalhados e nada óbvios que uma busca textual não acha. Depois o planner lê o código-fonte real em cada endereço.',
      },
      applying: {
        title: 'Aplicar é chato de propósito',
        body: 'As âncoras precisam casar exatamente byte a byte e uma única vez. Tudo é verificado antes de qualquer escrita. Todo arquivo tocado é copiado junto com seu hash pré-patch, para que o rollback consiga provar o que está restaurando.',
      },
      incremental: {
        title: 'Ele se mantém atual de forma incremental',
        body: 'O resync compara o grafo antigo com o novo e regenera só o que realmente mudou. Toque três arquivos, pague por três arquivos. A documentação para de apodrecer porque atualizá-la parou de ser caro.',
      },
    },
    limitsTitle: 'E ele declara os próprios limites',
    limitsBody:
      'As linguagens lidas pelo analisador guiado por configuração são nomeadas na visão geral, para que “relações de chamada de melhor esforço” nunca passem por “exatas”.',
    limitsLink: 'Fidelidade da análise',
    formatsTitle: 'Uma execução. Seis formatos de entrega.',
    formatsLede:
      'A geração é a parte cara e acontece uma vez. Tudo abaixo é re-renderização determinística que você pode rodar a cada commit.',
    formats: {
      markdown: {
        title: 'Handbook em Markdown',
        body: 'visão geral · índice · uma página por etapa · tabela de registradores de estado',
      },
      html: {
        title: 'Site HTML multipágina',
        body: 'TOC fixo, breadcrumbs, troca de tema — funciona via file://',
      },
      single: {
        title: 'Uma página autocontida',
        body: 'um único .html para mandar por e-mail ou anexar a um ticket',
      },
      agent: {
        title: 'Índice localizador para agentes',
        body: 'dever · conceitos de entrada · estado · exemplares · co-mudanças',
      },
      llms: { body: 'a convenção llms.txt, mais o handbook inteiro achatado' },
      skill: {
        title: 'Pacote SKILL de agente',
        body: 'SKILL.md + references/ + um hash de conteúdo por arquivo',
      },
    },
    closingTitle: 'Comece pelo comando gratuito',
    closingBefore: 'O ',
    closingAfter:
      ' nunca precisa de chave de API. Rode no seu repositório, olhe as contagens de arquivos e funções e decida se o resto vale um único token.',
    ctaInstall: 'Instalar',
    ctaCli: 'Referência da CLI',
  },

  // "руководство" for the artifact, as in every Russian page here; "справочник"
  // is reserved for a reference (справочник CLI, справочник по конфигурации).
  ru: {
    badgeLanguages: '18 ЯЗЫКОВ',
    badgeEndpoint: 'ЛЮБАЯ OPENAI-СОВМЕСТИМАЯ КОНЕЧНАЯ ТОЧКА',
    headline: 'Одна кодовая база на входе. ',
    headlineAccent: 'Два руководства на выходе — одно читает команда, по другому ориентируется агент.',
    heroLead:
      'Ваш кодинг-агент делает grep по символу, находит три из семи важных мест и отдаёт половину изменения. Это сбой не рассуждения, а ',
    heroEmphasis: 'маршрутизации',
    heroRest: '. Handbook даёт ему карту.',
    ctaDemo: 'Запустить офлайн-демо',
    ctaDocs: 'Читать документацию',
    snippetComment: '# весь конвейер, офлайн, без API-ключа, ~30 с',
    snippetNote: 'Встроенный образец проекта, встроенный mock-сервер LLM. Ни одного потраченного токена.',
    pipelineTitle: 'Семь команд, один цикл',
    pipelineLede:
      'Бирюзовые шаги детерминированы — без LLM и без сети, их можно бесплатно перезапускать в CI. Янтарные шаги обращаются к вашей конечной точке и кешируют то, что узнали.',
    noLlm: 'БЕЗ LLM',
    steps: {
      analyze: 'Разбирает каждый файл в типизированный граф вызовов.',
      generate: 'Карточки, этапы, проза, межэтапное состояние.',
      render: 'Markdown, HTML, индекс для агентов, llms.txt.',
      skill: 'Упаковывает всё для вашего кодинг-агента.',
      plan: 'Сводит правку к байт-точным изменениям.',
      apply: 'Патч «всё или ничего», с откатом.',
      resync: 'Прокатывает руководство вперёд. Без пересборки.',
    },
    pipelineMore: 'Как работает каждая фаза',
    pipelineDiagramAlt:
      'Конвейер Handbook: analyze, generate, render, skill, plan, apply и контур обратной связи resync',
    pillarsTitle: 'Почему прочитанному можно доверять',
    pillars: {
      parser: {
        title: 'Факты берутся из парсера',
        body: 'tree-sitter строит граф вызовов: функции, разрешённые рёбра, граничные вызовы и вызовы, которые разрешить не удалось, — они помещаются в карантин и никогда не угадываются. Этот слой никогда не касается LLM, поэтому он одинаков в каждом запуске.',
      },
      prose: {
        title: 'Проза ложится сверху — и говорит об этом',
        body: 'LLM пишет, для чего нужен файл и как устроена подсистема, всегда привязываясь к графу. Там, где она не получилась, структура всё равно выпускается — с пустым описанием. Отсутствующее предложение лучше выдуманного.',
      },
      routing: {
        title: 'Построено для маршрутизации, а не для чтения',
        body: 'Результат отвечает на вопрос «какие файлы, функции и состояние должно затронуть это изменение?» — включая разбросанные и неочевидные, которые текстовый поиск пропускает. Затем планировщик читает реальные исходники по каждому адресу.',
      },
      applying: {
        title: 'Применение скучно намеренно',
        body: 'Якорь должен совпадать байт в байт и ровно один раз. Всё проверяется до того, как что-либо будет записано. Каждый затронутый файл сохраняется вместе с хешем до патча, поэтому откат может доказать, что именно он восстанавливает.',
      },
      incremental: {
        title: 'Оно остаётся актуальным инкрементально',
        body: 'Resync сравнивает старый граф вызовов с новым и перегенерирует только то, что действительно изменилось. Тронули три файла — платите за три файла. Документация перестаёт гнить, потому что её обновление перестало быть дорогим.',
      },
    },
    limitsTitle: 'И раскрывает собственные границы',
    limitsBody:
      'Языки, которые читает анализатор на основе конфигурации, названы в обзоре, поэтому «отношения вызовов по мере возможностей» невозможно прочитать как «точные».',
    limitsLink: 'Достоверность анализа',
    formatsTitle: 'Один запуск. Шесть готовых форматов.',
    formatsLede:
      'Генерация — дорогая часть, и она выполняется один раз. Всё ниже — детерминированный ре-рендер, который можно запускать на каждом коммите.',
    formats: {
      markdown: {
        title: 'Markdown-руководство',
        body: 'обзор · индекс · страница на каждый этап · таблица регистров состояния',
      },
      html: {
        title: 'Многостраничный HTML-сайт',
        body: 'липкое оглавление, хлебные крошки, смена темы — работает по file://',
      },
      single: {
        title: 'Одна автономная страница',
        body: 'один .html, который можно отправить почтой или приложить к тикету',
      },
      agent: {
        title: 'Индекс-локатор для агентов',
        body: 'назначение · понятия входа · состояние · образцы · со-правки',
      },
      llms: { body: 'конвенция llms.txt плюс всё то же самое одним полотном' },
      skill: {
        title: 'Агентный SKILL-пакет',
        body: 'SKILL.md + references/ + хеш содержимого на каждый файл',
      },
    },
    closingTitle: 'Начните с бесплатной команды',
    closingBefore: '',
    closingAfter:
      ' никогда не требует API-ключа. Запустите её на своём репозитории, посмотрите на число файлов и функций и решите, стоит ли остальное хотя бы одного токена.',
    ctaInstall: 'Установить',
    ctaCli: 'Справочник CLI',
  },

  ja: {
    badgeLanguages: '18 言語',
    badgeEndpoint: 'あらゆる OpenAI 互換エンドポイント',
    headline: 'ひとつのコードベースから、',
    headlineAccent: '二冊のハンドブック——一冊はチームが読み、一冊はエージェントが辿る。',
    heroLead:
      'コーディングエージェントはシンボルを grep し、本当に重要な 7 箇所のうち 3 箇所を見つけ、半分だけ直した変更を出荷します。これは推論の失敗ではなく、',
    heroEmphasis: 'ルーティング',
    heroRest: 'の失敗です。Handbook はそのためのマップを渡します。',
    ctaDemo: 'オフラインのデモを実行',
    ctaDocs: 'ドキュメントを読む',
    snippetComment: '# パイプライン全体、オフライン、API キー不要、約 30 秒',
    snippetNote: '同梱のサンプルプロジェクトと、同梱のモック LLM。トークン消費はゼロ。',
    pipelineTitle: '7 つのコマンド、1 つのループ',
    pipelineLede:
      'ティールのステップは決定的です — LLM もネットワークも使わず、CI で何度でも無料で再実行できます。アンバーのステップはあなたのエンドポイントと話し、学んだことをキャッシュします。',
    noLlm: 'LLM なし',
    steps: {
      analyze: '全ファイルを型付きコールグラフへパースします。',
      generate: 'カード、ステージ、文章、ステージ横断の状態。',
      render: 'Markdown、HTML、エージェント索引、llms.txt。',
      skill: 'コーディングエージェント向けにパッケージ化します。',
      plan: '変更をバイト一致の編集へ絞り込みます。',
      apply: 'オール・オア・ナッシングの適用、ロールバック付き。',
      resync: 'ハンドブックを前へ進めます。再構築は不要。',
    },
    pipelineMore: '各フェーズの仕組み',
    pipelineDiagramAlt:
      'Handbook のパイプライン: analyze、generate、render、skill、plan、apply、そして resync のフィードバックループ',
    pillarsTitle: '読んだ内容を信頼できる理由',
    pillars: {
      parser: {
        title: '事実はパーサーから',
        body: 'tree-sitter がコールグラフを構築します: 関数、解決済みエッジ、境界呼び出し、そして解決できなかった呼び出し — 後者は隔離され、決して推測で補われません。このレイヤーは LLM に一切触れないので、何度実行しても同じです。',
      },
      prose: {
        title: '文章は事実の上に載り、そう明示される',
        body: 'ファイルが何のためにあるか、サブシステムがどうつながっているかは LLM が書き、常にグラフにアンカーされます。失敗しても構造はそのまま出荷され、説明が空になるだけです。でっち上げられた一文より、欠けている一文のほうがましです。',
      },
      routing: {
        title: '読むためではなく、ルーティングのために',
        body: '出力は「この変更はどのファイル・関数・状態に触れなければならないか?」に答えます — テキスト検索が見落とす、散在していて見つけにくいものも含めて。そのうえでプランナーが、見つけた各アドレスで実際のソースを読みます。',
      },
      applying: {
        title: '適用は意図して退屈に',
        body: 'アンカーはバイト単位で一意に一致しなければなりません。何かが書き込まれる前に、すべてが検証されます。触れたファイルはパッチ前のハッシュとともにバックアップされるので、ロールバックは何を復元しているのかを証明できます。',
      },
      incremental: {
        title: 'インクリメンタルに最新を保つ',
        body: 'resync は古いコールグラフと新しいものを差分比較し、実際に変わったものだけを再生成します。3 ファイル触れば、3 ファイル分の支払いです。更新が高価でなくなったので、ドキュメントは腐らなくなります。',
      },
    },
    limitsTitle: '自らの限界も開示する',
    limitsBody:
      '設定駆動アナライザが読んだ言語は概要に名指しされるため、「ベストエフォートの呼び出し関係」が「正確」と読まれることはありません。',
    limitsLink: '解析忠実度',
    formatsTitle: '1 回の実行。6 つの出荷形式。',
    formatsLede:
      '高コストなのは生成で、それは一度きりです。以下はすべて決定的な再レンダリングで、コミットごとに実行できます。',
    formats: {
      markdown: {
        title: 'Markdown ハンドブック',
        body: '概要 · 索引 · ステージごとに 1 ページ · 状態レジスタの表',
      },
      html: {
        title: '複数ページの HTML サイト',
        body: '固定 TOC、パンくずリスト、テーマ切替 — file:// でも動作',
      },
      single: {
        title: '自己完結の 1 ページ',
        body: 'メールで送れて、チケットにも添付できる .html 1 枚',
      },
      agent: {
        title: 'エージェント用ロケータ索引',
        body: '役割 · 入口概念 · 状態 · 代表例 · 共変更ヒント',
      },
      llms: { body: 'llms.txt 規約に準拠、加えて全体を平坦化した 1 ファイル' },
      skill: {
        title: 'エージェント SKILL パッケージ',
        body: 'SKILL.md + references/ + ファイルごとのコンテンツハッシュ',
      },
    },
    closingTitle: '無料のコマンドから始める',
    closingBefore: '',
    closingAfter:
      ' は API キーを必要としません。自分のリポジトリで実行し、ファイル数と関数数を確認してから、残りにトークンを 1 つ使う価値があるかどうかを決めてください。',
    ctaInstall: 'インストール',
    ctaCli: 'CLI リファレンス',
  },

  // Informal "du", as on every German content page here. The localised diagrams
  // still say "Ihr"; the prose is what a reader carries into the docs.
  de: {
    badgeLanguages: '18 SPRACHEN',
    badgeEndpoint: 'JEDER OPENAI-KOMPATIBLE ENDPUNKT',
    headline: 'Eine Codebasis rein. ',
    headlineAccent:
      'Zwei Handbücher raus — eines liest dein Team, mit dem anderen findet dein Agent den Weg.',
    heroLead:
      'Dein Coding-Agent greppt nach einem Symbol, findet drei der sieben Stellen, auf die es ankommt, und liefert eine halbe Änderung. Das ist kein Denkfehler, sondern ein ',
    heroEmphasis: 'Routing',
    heroRest: '-Fehler. Handbook gibt ihm die Karte.',
    ctaDemo: 'Offline-Demo starten',
    ctaDocs: 'Dokumentation lesen',
    snippetComment: '# komplette Pipeline, offline, kein API-Schlüssel, ~30 s',
    snippetNote: 'Mitgeliefertes Beispielprojekt, mitgeliefertes Mock-LLM. Null Tokens verbraucht.',
    pipelineTitle: 'Sieben Befehle, eine Schleife',
    pipelineLede:
      'Türkise Schritte sind deterministisch — kein LLM, kein Netzwerk, beliebig oft in CI wiederholbar. Gelbe Schritte sprechen mit deinem Endpunkt und cachen, was sie lernen.',
    noLlm: 'KEIN LLM',
    steps: {
      analyze: 'Parst jede Datei in einen typisierten Aufrufgraphen.',
      generate: 'Karten, Etappen, Prosa, etappenübergreifender Zustand.',
      render: 'Markdown, HTML, Agentenindex, llms.txt.',
      skill: 'Paketiert es für deinen Coding-Agenten.',
      plan: 'Verortet eine Änderung in byte-exakte Edits.',
      apply: 'Alles-oder-nichts-Patch, mit Rollback.',
      resync: 'Schreibt das Handbuch fort. Kein Neuaufbau.',
    },
    pipelineMore: 'Wie jede Phase funktioniert',
    pipelineDiagramAlt:
      'Die Handbook-Pipeline: analyze, generate, render, skill, plan, apply und die resync-Rückkopplung',
    pillarsTitle: 'Warum du dem Gelesenen trauen kannst',
    pillars: {
      parser: {
        title: 'Fakten kommen aus einem Parser',
        body: 'tree-sitter baut den Aufrufgraphen: Funktionen, aufgelöste Kanten, Grenzaufrufe und die Aufrufe, die es nicht auflösen konnte — in Quarantäne gestellt, niemals geraten. Diese Schicht berührt nie ein LLM und ist deshalb in jedem Lauf dieselbe.',
      },
      prose: {
        title: 'Prosa liegt darüber — und sagt es',
        body: 'Ein LLM schreibt, wozu eine Datei da ist und wie ein Subsystem zusammenhängt, immer im Graphen verankert. Wo es scheitert, wird die Struktur trotzdem ausgeliefert — mit leerer Beschreibung. Ein fehlender Satz ist besser als ein erfundener.',
      },
      routing: {
        title: 'Zum Routen gebaut, nicht zum Lesen',
        body: 'Die Ausgabe beantwortet: „Welche Dateien, Funktionen und Zustände muss diese Änderung anfassen?“ — auch die verstreuten, nicht offensichtlichen, die eine Textsuche übersieht. Dann liest der Planner an jeder Adresse den echten Quelltext.',
      },
      applying: {
        title: 'Anwenden ist absichtlich langweilig',
        body: 'Anker müssen byte-exakt und eindeutig passen. Alles wird geprüft, bevor irgendetwas geschrieben wird. Jede berührte Datei wird mit ihrem Hash von vor dem Patch gesichert, damit das Rollback beweisen kann, was es wiederherstellt.',
      },
      incremental: {
        title: 'Es bleibt inkrementell aktuell',
        body: 'Resync vergleicht den alten Aufrufgraphen mit dem neuen und regeneriert nur, was sich wirklich geändert hat. Drei Dateien angefasst, für drei Dateien bezahlt. Dokumentation verrottet nicht mehr, weil ihre Aktualisierung nicht mehr teuer ist.',
      },
    },
    limitsTitle: 'Und es legt seine eigenen Grenzen offen',
    limitsBody:
      'Sprachen, die der konfigurationsgetriebene Analyzer liest, werden im Überblick namentlich genannt — „Best-Effort-Aufrufbeziehungen“ können damit nie als „exakt“ gelesen werden.',
    limitsLink: 'Analysetreue',
    formatsTitle: 'Ein Lauf. Sechs Lieferformate.',
    formatsLede:
      'Die Generierung ist der teure Teil, und sie passiert einmal. Alles darunter ist ein deterministisches Re-Rendering, das du bei jedem Commit laufen lassen kannst.',
    formats: {
      markdown: {
        title: 'Markdown-Handbuch',
        body: 'Überblick · Index · eine Seite pro Etappe · Zustandsregister-Tabelle',
      },
      html: {
        title: 'Mehrseitige HTML-Site',
        body: 'Sticky-TOC, Breadcrumbs, Theme-Umschalter — läuft über file://',
      },
      single: {
        title: 'Eine eigenständige Seite',
        body: 'eine einzelne .html, die du mailen oder an ein Ticket hängen kannst',
      },
      agent: {
        title: 'Agenten-Locator-Index',
        body: 'Aufgabe · Kernkonzepte · Zustand · Exemplare · Co-Change-Hinweise',
      },
      llms: { body: 'die llms.txt-Konvention, plus das Ganze flach in einer Datei' },
      skill: {
        title: 'Agenten-SKILL-Paket',
        body: 'SKILL.md + references/ + ein Inhalts-Hash pro Datei',
      },
    },
    closingTitle: 'Fang mit dem kostenlosen Befehl an',
    closingBefore: '',
    closingAfter:
      ' braucht nie einen API-Schlüssel. Lass ihn über dein Repo laufen, sieh dir die Datei- und Funktionszahlen an und entscheide dann, ob der Rest einen einzigen Token wert ist.',
    ctaInstall: 'Installieren',
    ctaCli: 'CLI-Referenz',
  },
};

/** The table for a locale, falling back to English for anything unknown. */
export function home(locale: string): HomeStrings {
  return HOME[(locale as Locale) in HOME ? (locale as Locale) : 'en'];
}
