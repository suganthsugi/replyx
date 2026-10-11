import { FlowHero } from '@/components/flow/FlowHero';
import { SectionCards } from '@/components/SectionCards';

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <FlowHero />
      <SectionCards />
    </main>
  );
}
