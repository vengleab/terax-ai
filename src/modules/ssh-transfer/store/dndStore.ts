import { create } from "zustand";
import { type DropTarget, targetEquals } from "../lib/dnd";

type DndState = {
  dragging: boolean;
  count: number;
  hover: DropTarget | null;
  begin: (count: number) => void;
  setHover: (hover: DropTarget | null) => void;
  end: () => void;
};

export const useDndStore = create<DndState>((set, get) => ({
  dragging: false,
  count: 0,
  hover: null,
  begin: (count) => set({ dragging: true, count }),
  setHover: (hover) => {
    if (!targetEquals(get().hover, hover)) set({ hover });
  },
  end: () => set({ dragging: false, count: 0, hover: null }),
}));
