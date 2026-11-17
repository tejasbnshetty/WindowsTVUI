import type { InputCommand } from "./protocol";
import type { Input } from "./input";

/** Maps a validated protocol command onto the Input API. Exhaustive by construction. */
export function dispatchInput(cmd: InputCommand, input: Input): void {
  switch (cmd.type) {
    case "mouse_move": input.moveRelative(cmd.dx, cmd.dy); break;
    case "mouse_click": input.click(cmd.button); break;
    case "mouse_down": input.mouseDown(cmd.button); break;
    case "mouse_up": input.mouseUp(cmd.button); break;
    case "scroll": input.scroll(cmd.dy, cmd.dx); break;
    case "key": input.namedKey(cmd.key); break;
    case "text": input.typeText(cmd.value); break;
    case "media": input.mediaKey(cmd.action); break;
  }
}
