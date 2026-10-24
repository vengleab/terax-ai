import { useEffect, useRef } from "react";

type Props = {
  initial: string;
  placeholder?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
};

function stemLength(name: string): number {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}

export function NameInput({ initial, placeholder, onCommit, onCancel }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(0, stemLength(initial));
  }, [initial]);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const value = ref.current?.value ?? "";
    if (commit) onCommit(value);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      defaultValue={initial}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      className="h-5 min-w-0 flex-1 rounded-sm border border-ring bg-background px-1 text-[13px] text-foreground outline-none"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}
