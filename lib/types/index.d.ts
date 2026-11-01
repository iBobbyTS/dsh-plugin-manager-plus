/**
 * dsh-plugin-manager-plus host entry: mounts the plugin manager's HTTP routes
 * once the profile composes the webServer and shell services.
 * Based on dsh-market (MIT).
 */
import type { Context } from '@deepseek-ai/cordis';
import { type MarketConfig } from './routes.ts';
export declare const name = "dsh-plugin-manager";
/** Optional cordis.yml configuration; profile defaults to `web`. */
export type Config = Partial<MarketConfig>;
export declare function apply(ctx: Context, config?: Config): void;
