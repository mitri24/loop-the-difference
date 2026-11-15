import postcss from 'postcss';
import {readFileSync, writeFileSync} from 'node:fs';
const css = postcss.parse(readFileSync(process.argv[2], 'utf8'));
css.walkRules(rule => {
  if (rule.parent.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
  rule.selectors = rule.selectors.map(s => '.reference-analysis ' + s);
});
writeFileSync(process.argv[3], css.toString());
