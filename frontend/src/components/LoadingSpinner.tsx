
import { cn } from "@/lib/utils";

interface LoadingSpinnerProps {
  className?: string;
}

const LoadingSpinner = ({ className }: LoadingSpinnerProps) => {
  return (
    <div className={cn("animate-spin rounded-full border-2 border-gray-300 border-t-blue-600", className)} />
  );
};

export default LoadingSpinner;
