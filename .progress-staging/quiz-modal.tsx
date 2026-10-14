import { apiFetch } from "@/lib/api-client";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { getAuthToken } from "@/lib/api-client";
import {
  CheckCircle,
  XCircle,
  RefreshCw,
  Trophy,
  AlertCircle,
  ChevronRight,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface QuizOption {
  id: string;
  optionText: string;
  optionOrder: number;
}

interface QuizQuestion {
  id: string;
  questionText: string;
  questionOrder: number;
  options: QuizOption[];
}

interface Quiz {
  lessonUpdatedAt?: string;
  id: string;
  lessonId: string;
  passingScore: number;
  questions: QuizQuestion[];
}

interface AttemptFeedback {
  questionId: string;
  questionText: string;
  chosenOptionId: string | null;
  correctOptionId: string;
  isCorrect: boolean;
}

interface AttemptResult {
  score: number;
  passingScore: number;
  passed: boolean;
  correct: number;
  total: number;
  feedback: AttemptFeedback[];
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function submitAttempt(
  lessonId: string,
  answers: Record<string, string>,
  lessonUpdatedAt?: string
): Promise<AttemptResult> {
  const token = getAuthToken();
  const res = await apiFetch(`/api/lessons/${lessonId}/quiz/attempt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ answers, lessonUpdatedAt }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Submission failed");
  }
  return res.json();
}

// ─── Main component ───────────────────────────────────────────────────────────

interface QuizModalProps {
  open: boolean;
  onClose: () => void;
  quiz: Quiz;
  lessonId: string;
  onPassed: () => void;
}

type Phase = "quiz" | "result";

export function QuizModal({ open, onClose, quiz, lessonId, onPassed }: QuizModalProps) {
  const { toast } = useToast();
  const [phase, setPhase] = useState<Phase>("quiz");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [current, setCurrent] = useState(0);

  const questions = quiz.questions.slice().sort((a, b) => a.questionOrder - b.questionOrder);
  const currentQ = questions[current];
  const totalQ = questions.length;
  const answered = Object.keys(answers).length;

  const submitMutation = useMutation({
    mutationFn: () => submitAttempt(lessonId, answers, quiz.lessonUpdatedAt),
    onSuccess: (data) => {
      setResult(data);
      setPhase("result");
      if (data.passed) {
        onPassed();
      }
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Submission error", description: (err as Error).message });
    },
  });

  const handleRetry = () => {
    setAnswers({});
    setResult(null);
    setPhase("quiz");
    setCurrent(0);
  };

  const handleClose = () => {
    if (phase === "quiz" && answered > 0) {
      // keep answers if closed mid-quiz so they can resume
    }
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        {phase === "quiz" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span>Lesson Quiz</span>
                <span className="text-sm font-normal text-muted-foreground ml-auto">
                  {current + 1} / {totalQ}
                </span>
              </DialogTitle>
            </DialogHeader>

            {/* Progress bar */}
            <Progress value={((current) / totalQ) * 100} className="h-1.5" />

            {/* Question */}
            <div className="space-y-4 mt-2">
              <p className="font-medium leading-relaxed">{currentQ.questionText}</p>

              <div className="space-y-2">
                {currentQ.options
                  .slice()
                  .sort((a, b) => a.optionOrder - b.optionOrder)
                  .map((opt) => {
                    const chosen = answers[currentQ.id] === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() =>
                          setAnswers((prev) => ({ ...prev, [currentQ.id]: opt.id }))
                        }
                        className={`w-full text-left rounded-lg border px-4 py-3 text-sm transition-all ${
                          chosen
                            ? "border-primary bg-primary/5 text-primary font-medium ring-1 ring-primary/30"
                            : "border-border hover:border-primary/40 hover:bg-muted/50"
                        }`}
                      >
                        {opt.optionText}
                      </button>
                    );
                  })}
              </div>

              <div className="flex justify-between pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={current === 0}
                  onClick={() => setCurrent((c) => c - 1)}
                >
                  Back
                </Button>

                {current < totalQ - 1 ? (
                  <Button
                    size="sm"
                    onClick={() => setCurrent((c) => c + 1)}
                    disabled={!answers[currentQ.id]}
                  >
                    Next <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => submitMutation.mutate()}
                    disabled={answered < totalQ || submitMutation.isPending}
                    className="gap-2"
                  >
                    {submitMutation.isPending ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle className="h-4 w-4" />
                    )}
                    Submit
                  </Button>
                )}
              </div>

              {/* Dots navigator */}
              <div className="flex justify-center gap-1.5 pt-1">
                {questions.map((q, i) => (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => setCurrent(i)}
                    className={`h-2 rounded-full transition-all ${
                      i === current
                        ? "w-5 bg-primary"
                        : answers[q.id]
                        ? "w-2 bg-primary/40"
                        : "w-2 bg-muted-foreground/20"
                    }`}
                  />
                ))}
              </div>
            </div>
          </>
        )}

        {phase === "result" && result && (
          <>
            <DialogHeader>
              <DialogTitle>
                {result.passed ? "Quiz Passed 🎉" : "Quiz Result"}
              </DialogTitle>
            </DialogHeader>

            {/* Score circle */}
            <div className="flex flex-col items-center py-6 gap-3">
              <div
                className={`h-24 w-24 rounded-full flex items-center justify-center text-2xl font-bold border-4 ${
                  result.passed
                    ? "border-primary text-primary bg-primary/5"
                    : "border-destructive text-destructive bg-destructive/5"
                }`}
              >
                {result.score}%
              </div>
              {result.passed ? (
                <div className="flex items-center gap-2 text-primary font-medium">
                  <Trophy className="h-5 w-5" /> You passed!
                </div>
              ) : (
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                  <AlertCircle className="h-4 w-4" />
                  Needed {result.passingScore}% to pass — got {result.correct}/{result.total} correct
                </div>
              )}
            </div>

            {/* Per-question feedback */}
            <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
              {result.feedback.map((fb, i) => (
                <div
                  key={fb.questionId}
                  className={`rounded-lg border px-3 py-2 text-sm flex items-start gap-2 ${
                    fb.isCorrect
                      ? "border-primary/20 bg-primary/5"
                      : "border-destructive/20 bg-destructive/5"
                  }`}
                >
                  {fb.isCorrect ? (
                    <CheckCircle className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                  )}
                  <span className="leading-relaxed text-foreground/80">
                    Q{i + 1}: {fb.questionText}
                  </span>
                </div>
              ))}
            </div>

            <div className="flex gap-3 pt-2">
              {!result.passed && (
                <Button variant="outline" className="flex-1" onClick={handleRetry}>
                  <RefreshCw className="h-4 w-4 mr-2" /> Try Again
                </Button>
              )}
              <Button className="flex-1" onClick={onClose}>
                {result.passed ? "Continue" : "Close"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
