/**
 * 外部 ACP agent 启动命令解析（U-002 第二平台插槽）
 *
 * 设置页 `externalAgent.command` 是单行 shell 风格字符串（用户配置任意可执行 +
 * 参数，如 `/opt/my-agent` 或 `java -jar agent.jar`）。spawn 需要 argv 数组，
 * 因此这里做最小切词：空白分隔 + 单引号原样包裹 + 双引号包裹（支持 `\"` 转义）。
 * 不做变量展开/管道/重定向——不是 shell，进程直接 spawn。
 *
 * 错误引用（未闭合引号）/纯空白/空命令 → null（调用方据此判定未就绪）。
 */
export interface LaunchSpec {
  command: string;
  args: string[];
}

export function parseLaunchCommand(input: string): LaunchSpec | null {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && input[i + 1] === '"') {
        current += '"';
        i++;
      } else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote !== null) return null; // 未闭合引号 → 错误配置
  if (inToken) tokens.push(current);
  if (tokens.length === 0 || tokens[0] === '') return null;
  return { command: tokens[0], args: tokens.slice(1) };
}
