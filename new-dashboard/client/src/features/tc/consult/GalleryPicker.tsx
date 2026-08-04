/**
 * Before & After gallery picker modal for Consult Prep — search + category
 * pills + selectable thumbnail grid. Ported from the legacy PrepConsult
 * dialog; media renders ONLY through the entitlement-checked proxy via
 * TcMediaPair, and category pills derive from the office's actual gallery
 * data (the platform gallery category is free text — there is no fixed
 * GALLERY_CATEGORIES list here).
 *
 * Selection is owned by the parent (page-local state — legacy never persisted
 * the picked set either).
 */
import { useMemo, useState } from "react";
import { CheckCircle2, Search as SearchIcon } from "lucide-react";
import type { OfficeId, TcGalleryCase } from "@shared/tc/contract";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TcMediaPair } from "../gallery/GalleryGrid";

export interface GalleryPickerProps {
  office: OfficeId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gallery: TcGalleryCase[];
  selectedIds: ReadonlySet<string>;
  onToggle: (galleryId: string) => void;
}

export function GalleryPicker({
  office,
  open,
  onOpenChange,
  gallery,
  selectedIds,
  onToggle,
}: GalleryPickerProps) {
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  const categories = useMemo(() => {
    const set = new Set<string>();
    gallery.forEach((g) => {
      const c = g.category.trim();
      if (c) set.add(c);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [gallery]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return gallery.filter((g) => {
      if (categoryFilter && g.category !== categoryFilter) return false;
      if (q) {
        return (
          g.title.toLowerCase().includes(q) ||
          g.category.toLowerCase().includes(q) ||
          g.description.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [gallery, categoryFilter, search]);

  const pillClass = (active: boolean) =>
    `text-[10px] px-2.5 py-1 rounded-full font-medium transition-colors ${
      active
        ? "bg-primary text-primary-foreground"
        : "bg-muted text-muted-foreground hover:bg-muted/80"
    }`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle style={{ fontFamily: "Sora, sans-serif" }}>
            Before &amp; After Gallery
          </DialogTitle>
        </DialogHeader>

        {/* Search */}
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search cases..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {/* Category pills (from real gallery data) */}
        {categories.length > 0 && (
          <div className="flex gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => setCategoryFilter(null)}
              className={pillClass(categoryFilter === null)}
            >
              All
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(categoryFilter === cat ? null : cat)}
                className={pillClass(categoryFilter === cat)}
              >
                {cat}
              </button>
            ))}
          </div>
        )}

        {/* Grid */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {filtered.map((g) => {
              const isSelected = selectedIds.has(g.galleryId);
              return (
                <button
                  key={g.galleryId}
                  type="button"
                  onClick={() => onToggle(g.galleryId)}
                  className={`relative rounded-lg border overflow-hidden text-left transition-all ${
                    isSelected
                      ? "border-2 border-primary ring-1 ring-primary/40 ring-offset-1"
                      : "border-border hover:border-muted-foreground/40"
                  }`}
                >
                  {isSelected && (
                    <div className="absolute top-1.5 right-1.5 z-10 w-5 h-5 rounded-full flex items-center justify-center bg-primary text-primary-foreground">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    </div>
                  )}
                  <TcMediaPair
                    office={office}
                    beforeKey={g.beforeBlobKey}
                    afterKey={g.afterBlobKey}
                    beforeLabel="Before"
                    afterLabel="After"
                    altBase={g.title}
                    heightClass="h-20"
                  />
                  <div className="px-2 py-1.5">
                    <div className="text-[10px] font-semibold truncate text-foreground">
                      {g.title}
                    </div>
                    <div className="text-[9px] text-muted-foreground truncate">
                      {[g.category, g.doctorName].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          {filtered.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-8">
              No cases match your search.
            </p>
          )}
        </div>

        <DialogFooter>
          <span className="text-xs text-muted-foreground mr-auto">
            {selectedIds.size} case{selectedIds.size === 1 ? "" : "s"} selected
          </span>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
