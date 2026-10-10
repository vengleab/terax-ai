import { describe, expect, it } from "vitest";
import { buildSshCommand } from "./sshCommand";

describe("buildSshCommand", () => {
  it("leaves plain words alone", () => {
    expect(buildSshCommand(["-p", "2222", "deploy@example.com"], false)).toBe(
      "ssh -p 2222 deploy@example.com",
    );
  });

  it("quotes anything with spaces or shell metacharacters", () => {
    expect(
      buildSshCommand(["-i", "/home/me/my keys/id", "-J", "ops@[::1]:22", "u@h"], false),
    ).toBe("ssh -i '/home/me/my keys/id' -J 'ops@[::1]:22' u@h");
    expect(buildSshCommand(["-i", "/k/it's"], false)).toBe("ssh -i '/k/it'\\''s'");
    expect(buildSshCommand(["a;b", "$(x)"], false)).toBe("ssh 'a;b' '$(x)'");
  });

  it("uses powershell quoting on windows", () => {
    expect(buildSshCommand(["-i", "C:/Users/me/my key"], true)).toBe("ssh -i 'C:/Users/me/my key'");
  });
});
