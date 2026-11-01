/**
 * dsh-plugin-manager-plus host entry: mounts the plugin manager's HTTP routes
 * once the profile composes the webServer and shell services.
 * Based on dsh-market (MIT).
 */
import { mountMarketRoutes } from './routes.js';
export const name = 'dsh-plugin-manager';
/**
 * Register the market against the host context.
 * @param ctx - Host context that may acquire webServer and shell services.
 * @param config - Optional profile override from the loader.
 */
/**
 * The profile this host process actually booted (`--profile <name>` on the
 * dsh CLI invocation). Without it the market would default to `web` and
 * installs from a test/secondary profile would mutate the real one.
 */
function argvProfile() {
    const argv = process.argv;
    const flag = argv.indexOf('--profile');
    if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith('-'))
        return argv[flag + 1];
    return undefined;
}
export function apply(ctx, config) {
    const resolved = {
        profile: config?.profile ?? argvProfile() ?? 'web',
        allowRestart: config?.allowRestart ?? true,
    };
    ctx.inject(['webServer', 'loader'], (hostCtx) => {
        const host = hostCtx;
        host.effect(() => mountMarketRoutes(host, resolved), 'plugin-manager: http routes');
    });
}
