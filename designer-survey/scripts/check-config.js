// 校验 config/questions.json 是否写对：npm run check
process.env.DATA_DIR = process.env.DATA_DIR || require('node:os').tmpdir();
const { getSurvey, CONFIG_PATH } = require('../lib/survey');
try {
  const s = getSurvey();
  console.log('✅ 配置正确：' + CONFIG_PATH);
  for (const sec of s.sections) {
    console.log(`\n${sec.id}. ${sec.title}`);
    for (const q of sec.questions) {
      const t = { single: '单选', multi: q.maxSelect ? `多选≤${q.maxSelect}` : '多选', text: '文本', textarea: '多行文本' }[q.type];
      console.log(`  ${q.no}. [${q.id}] ${q.title}（${t}${q.required ? '' : '，选填'}）${q.options ? ' — ' + q.options.length + ' 个选项' : ''}`);
    }
  }
} catch (e) {
  console.error('❌ 配置有误：' + e.message);
  process.exit(1);
}
