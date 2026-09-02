import { Link } from "wouter";
import { AlertCircle, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

// Rendered inside Layout, so this only fills the content area rather than
// painting its own full-height page chrome.
export default function NotFound() {
  return (
    <div className="pin-card flex flex-col items-center justify-center p-6 text-center sm:p-12">
      <div className="w-14 h-14 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
        <AlertCircle className="h-7 w-7 text-destructive" />
      </div>
      <h1 className="text-xl font-bold text-foreground">Page not found</h1>
      <p className="text-muted-foreground mt-2 text-sm max-w-sm">
        That address does not match any page in Email Watcher.
      </p>
      <Button asChild className="pin-btn-primary mt-6 w-full sm:w-auto">
        <Link href="/">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Dashboard
        </Link>
      </Button>
    </div>
  );
}
