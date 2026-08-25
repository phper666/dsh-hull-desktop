import { HullError } from '../../shared/errors';
import { INSTALL_ERRORS } from '../OverlayManager';
import { NpmRunner, PnpmRunner } from './npmRunner';
import type { PkgMgrName, PkgMgrResult, PkgMgrRunOptions, PkgMgrRunner, PkgMgrRunnerOptions } from './types';

export type { PkgMgrName, PkgMgrResult, PkgMgrRunOptions, PkgMgrRunner, PkgMgrRunnerOptions } from './types';
export { NpmRunner, PnpmRunner } from './npmRunner';

/** 工厂：按包管理器名返回对应执行器（P1：npm/pnpm 两实现；默认回退 npm） */
export function createPkgMgrRunner(name: PkgMgrName, options: PkgMgrRunnerOptions): PkgMgrRunner {
  switch (name) {
    case 'pnpm':
      return new PnpmRunner(options);
    case 'npm':
    default:
      return new NpmRunner(options);
  }
}

/** 适配 OverlayManager.runNpmInstall 注入点：PkgMgrResult → 抛 HullError（错误码透传）。
 *  registry/onLine 随 opts 注入（main 接 settings.registry + 输出接线）。 */
export function toRunNpmInstall(runner: PkgMgrRunner, opts: PkgMgrRunOptions = { registry: '' }) {
  return (stagingDir: string, targetVersion: string): Promise<void> => {
    return runner.install(stagingDir, targetVersion, opts).then((r: PkgMgrResult) => {
      if (!r.ok) throw new HullError(r.code ?? INSTALL_ERRORS.npmInstallFailed, r.error ?? '安装失败');
    });
  };
}
