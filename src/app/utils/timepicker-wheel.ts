import { PluginRegistry } from 'timepicker-ui';
import { WheelPlugin } from 'timepicker-ui/plugins/wheel';

let registered = false;

export function ensureTimepickerWheelPlugin() {
  if (registered) return;
  PluginRegistry.register(WheelPlugin as any);
  registered = true;
}
