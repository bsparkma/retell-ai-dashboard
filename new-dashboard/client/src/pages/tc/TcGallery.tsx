/**
 * /tc/gallery — Before & After gallery + smile simulation history.
 *
 * Two tabs over the office-scoped media entities. All bytes render through the
 * tcMediaUrl proxy; generation is disabled until Slice 7 (see SmileSimList).
 */
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TcOfficeGate, TcPageHeader, useTcOffice } from "@/features/tc/components/TcShell";
import { GalleryGrid } from "@/features/tc/gallery/GalleryGrid";
import { SmileSimList } from "@/features/tc/gallery/SmileSimList";

export default function TcGallery() {
  const office = useTcOffice();
  if (!office) {
    return (
      <div className="p-6">
        <TcOfficeGate />
      </div>
    );
  }

  return (
    <div className="p-6">
      <TcPageHeader
        title="Gallery"
        subtitle="Before & after cases and smile simulations for patient presentations"
      />
      <Tabs defaultValue="gallery">
        <TabsList className="mb-4">
          <TabsTrigger value="gallery">Before &amp; After</TabsTrigger>
          <TabsTrigger value="sims">Smile Simulations</TabsTrigger>
        </TabsList>
        <TabsContent value="gallery">
          <GalleryGrid office={office} />
        </TabsContent>
        <TabsContent value="sims">
          <SmileSimList office={office} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
