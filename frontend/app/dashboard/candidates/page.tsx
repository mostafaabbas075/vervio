import { AdminSection } from "@/components/dashboard/admin-section";
import { CandidatesWorkspace } from "@/components/dashboard/candidates-workspace";

export default function CandidatesPage() {
  return (
    <AdminSection>
      <CandidatesWorkspace />
    </AdminSection>
  );
}
