/**
 * Bilingual pattern tables for learning.
 *
 * These are deliberately small and readable: each entry is a regular
 * expression, a category and a weight. Learning does not pretend to understand
 * language; it recognises the shapes humans use to state standing instructions
 * ("以后…", "always…"), enduring facts ("我是…", "we use…") and corrections
 * ("不对…", "that's wrong…"), then stores the sentence as it was said. The model
 * itself does the understanding when it writes or recalls memories through the
 * tools; the automatic channel only needs to be good at *selection*.
 */

/** A pattern entry: `[regex, category, weight]`. */
const P = (source, flags = 'i') => new RegExp(source, flags)

//#region preference patterns
/** How the user wants work done. `category` names the subject family. */
export const PREFERENCE_PATTERNS = [
  // Language / tone
  [P('(?:以后|之后|接下来|今后|往后)[^。！？\\n]{0,20}(?:用|说|回复|回答|写)[^。！？\\n]{0,6}(?:中文|英文|English|Chinese|日语|日文)'), 'language', 0.9],
  [P('(?:always|from now on|in future|今后|以后)\\s+(?:reply|respond|answer|speak|write)[^.!?\\n]{0,20}(?:in english|in chinese|中文|英文)'), 'language', 0.9],
  [P('(?:回复|回答|说话)[^。！？\\n]{0,8}(?:简洁|简短|直接|详细|专业|口语|白话|英文|中文|不要客套|别客套)'), 'tone', 0.8],
  [P('(?:be|keep it|answer)\\s+(?:concise|brief|short|detailed|direct)'), 'tone', 0.7],
  [P('(?:不要|别|禁止|never|do not|don\'?t)\\s*(?:再)?(?:加|写|用|使用|加这么多|这么)[^。！？\\n]{0,10}(?:注释|注释块|emoji|表情|客套|废话|markdown)'), 'style', 0.85],
  [P('(?:no|avoid|stop using)\\s+(?:emojis?|comments?|filler|marketing speak)'), 'style', 0.75],
  // Tooling and workflow
  [P('(?:都|统一|一律|always|from now on|以后)[^。！？\\n]{0,6}(?:用|使用|use)\\s*(?:pnpm|npm|yarn|bun|pnpm|uv|pip|conda|poetry|deno|vite|webpack|rollup|esbuild)'), 'tooling', 0.85],
  [P('(?:默认|default)[^。！？\\n]{0,8}(?:用|使用|use|是|to)\\s*[A-Za-z][\\w.+-]{1,20}'), 'tooling', 0.7],
  [P('(?:先|before|first)[^。！？\\n]{0,12}(?:再|then|after)\\s*(?:问|确认|沟通|ask|confirm|explain)'), 'workflow', 0.8],
  [P('(?:不要|别|never|don\'?t|stop)\\s*(?:擅自|自动|未经)[^。！？\\n]{0,16}(?:改|删|安装|推送|提交|push|commit|install|delete)'), 'workflow', 0.9],
  [P('(?:commit|提交|push|推送)[^。！？\\n]{0,12}(?:message|信息|说明)[^。！？\\n]{0,6}(?:中文|英文|english|chinese|conventional|格式)'), 'workflow', 0.7],
  [P('(?:测试|test)[^。！？\\n]{0,6}(?:先|优先|always|每次|跑|run)'), 'workflow', 0.7],
  [P('(?:命名|变量名|naming)[^。！？\\n]{0,8}(?:用|使用|snake|kebab|camel)'), 'style', 0.6],
  [P('(?:my|our|我|我们)\\s*(?:prefer|喜欢|习惯|倾向)\\s+[^。！？\\n]{2,40}'), 'likes', 0.7],
  [P('(?:prefer|like|习惯了?)\\s+(?:using|to use|用)\\s+[^。！？\\n]{2,30}'), 'likes', 0.65],
  // Corrections
  [P('(?:不对|错了|说错了|弄错了|搞错了|不是这样|不是这个意思|改一下|改成|纠正一下|重新来)'), 'correction', 0.85],
  [P('(?:that\'?s (?:wrong|not right)|incorrect|actually,?\\s|instead,?\\s|not what i (?:asked|meant))'), 'correction', 0.8],
]

/** Explicit requests to remember something — the strongest learning signal. */
export const EXPLICIT_MEMORY_PATTERNS = [
  [P('(?:记住|记一下|记下|别忘了|请你记住|帮我记住|备注)[^。！？\\n]{2,}'), 'explicit', 1],
  [P('(?:remember|note down|keep in mind|don\'?t forget)\\b[^.!?\\n]{2,}'), 'explicit', 1],
  [P('(?:下次|下一次|以后|今后|后面)[^。！？\\n]{2,}(?:就|都|要|别|不要)'), 'standing-instruction', 0.85],
  [P('(?:from now on|whenever|next time|every time)\\b[^.!?\\n]{2,}'), 'standing-instruction', 0.85],
  [P('(?:importantly|important:|注意|重点|切记|务必)[:：]?[^。！？\\n]{2,}'), 'emphasis', 0.75],
]

/** Enduring facts and decisions worth remembering even without "remember". */
export const ACTION_PATTERNS = [
  [P('我(?:是|叫|在|住|做|负责|从事|的(?:职业|工作|项目|公司|团队|技术栈|语言|系统|平台))[^。！？\\n]{2,}'), 'identity', 0.9],
  [P('\\b(?:i am|i\'m|i work (?:at|on|with)|i live in|my name is|my (?:job|role|team|stack|project) is)\\b[^.!?\\n]{2,}'), 'identity', 0.9],
  [P('(?:我们|咱们|my|our)\\s*(?:的)?\\s*(?:项目|team|project|repo|仓库|产品|公司|业务)[^。！？\\n]{0,12}(?:是|用|在|server|使用|基于|叫|名为|named|called)'), 'project', 0.75],
  [P('(?:决定|结论|方案|约定|最终|定下来|decided|we\'ll go with|the plan is)[^。！？\\n]{2,}'), 'decision', 0.8],
  [P('(?:原因|因为|问题在于|根因|好在|幸好|教训|踩坑|坑|root cause|because|turns out)[^。！？\\n]{2,}'), 'lesson', 0.6],
  [P('(?:路径|目录|端口|地址|域名|账号|服务器|数据库|path|port|host|database)\\s*(?:是|为|在|:|：|=)\\s*[^。！？\\n]{2,}'), 'fact', 0.6],
  [P('[\\w\\u4e00-\\u9fff]{1,20}(?:用|使用|采用|基于)\\s*[A-Za-z][\\w.+#-]{1,20}'), 'fact', 0.6],
  [P('(?:以后|下次|今后|from now on|next time)[^。！？\\n]{2,}'), 'standing-instruction', 0.7],
]

/** Markers that the user judged the agent's output as wrong or unhelpful. */
export const FAILURE_MARKERS = [
  '不对', '错了', '不行', '没用', '不是我要的', '重做', '还是错', '又错', '失败了', '跑不通',
  'that\'s wrong', 'that is wrong', 'doesn\'t work', 'didn\'t work', 'not working', 'try again', 'incorrect',
]

/**
 * Find the first pattern in `table` that matches `text`.
 * @param {string} text
 * @param {Array<[RegExp, string, number]>} table
 * @returns {{ match: string, category: string, weight: number } | null}
 */
export function matchPattern(text, table) {
  for (const [regex, category, weight] of table) {
    regex.lastIndex = 0
    const found = regex.exec(text)
    if (found !== null) return { match: found[0], category, weight }
  }
  return null
}

/** Shell invocations DSH injects as a user turn when a `/command` runs. */
const COMMAND_LINE_RE = /^\s*(?:\$|>|!)\s+(\S.*)$/m
const COMMAND_BLOCK_RE = /```(?:bash|sh|shell|powershell|pwsh|cmd)?\n([\s\S]*?)```/
/** The prefix DSH puts in front of a message that actually ran a command. */
const COMMAND_PREFIX_RE = /^\s*the user sent a command:\s*/i

/**
 * If a user message is really a command (DSH hook injection, or a bare
 * `/name args`), return the command text; otherwise null.
 *
 * Commands are learned as command patterns, keyed by their arguments, instead
 * of being stored as if the user had said them.
 * @param {string} text
 * @returns {string | null}
 */
export function extractCommandFromUserText(text) {
  const source = String(text ?? '').replace(COMMAND_PREFIX_RE, '')
  const block = COMMAND_BLOCK_RE.exec(source)
  if (block !== null && /command|指定|执行/i.test(source.slice(0, block.index))) {
    return oneLineInner(block[1])
  }
  const line = COMMAND_LINE_RE.exec(source)
  if (line !== null && source.trim().length < 400) return oneLineInner(line[1])
  const slash = /^\s*\/([a-z][\w-]*)\s*(.*)$/i.exec(source)
  if (slash !== null) {
    const args = slash[2].trim()
    return oneLineInner(args === '' ? slash[1] : `${slash[1]} ${args}`)
  }
  // After the DSH marker, whatever follows is the command even when it is
  // plain prose ("run tests"): that is how DSH delivers it.
  if (COMMAND_PREFIX_RE.test(String(text ?? ''))) return oneLineInner(source)
  return null
}

function oneLineInner(value) {
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text === '' ? null : text.slice(0, 300)
}

/**
 * Derive the subject key of a preference: which thing the statement is about.
 * Two statements with the same subject but opposite polarity supersede each
 * other instead of accumulating.
 *
 * Family-level patterns collapse to their family, because a later tone
 * instruction really does replace the earlier one ("更简洁" replaces "少客套").
 * Everything else keys on its distinctive terms, so "用 pnpm" and "回复要简洁"
 * never collide; Chinese text is keyed by single characters because two
 * preferences rarely share the exact same bigrams.
 * @param {string} text
 * @returns {string}
 */
export function subjectOf(text) {
  const source = String(text ?? '')
  const hit = matchPattern(source, PREFERENCE_PATTERNS.filter(([, category]) => FAMILY_SUBJECTS.has(category)))
  if (hit !== null) return `family:${hit.category}`
  const cjk = source.match(/[\u3400-\u4dbf\u9fff]+/g)?.join('') ?? ''
  const ascii = (source.toLowerCase().match(/[a-z][a-z0-9_.+-]{1,}/g) ?? [])
    .filter(word => !STOP.has(word))
  const parts = []
  if (ascii.length > 0) parts.push(ascii.slice(-3).join(' '))
  if (cjk !== '') parts.push([...new Set(cjk.split(''))].join(''))
  return parts.join(' ') || [...source.toLowerCase().replace(/\s+/g, '')].slice(0, 8).join('')
}

/** Categories whose later statement supersedes an earlier one wholesale. */
const FAMILY_SUBJECTS = new Set(['language', 'tone', 'style', 'tooling', 'workflow', 'correction'])

/** Words too common to identify a subject. */
const STOP = new Set(['the', 'and', 'for', 'use', 'with', 'always', 'never', 'from', 'now', 'that', 'this', 'you'])
//#endregion
