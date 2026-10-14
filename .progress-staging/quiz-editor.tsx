import { apiFetch } from "@/lib/api-client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { getAuthToken } from "@/lib/api-client";
import {
  Loader2,
  Plus,
  Trash2,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  ClipboardList,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface OptionDraft {
  id: string; // local draft id
  optionText: string;
  isCorrect: boolean;
}

interface QuestionDraft {
  id: string; // local draft id
  questionText: string;
  options: OptionDraft[];
}

interface QuizData {
  id: string;
  lessonId: string;
  passingScore: number;
  questions: Array<{
    id: string;
    questionText: string;
    questionOrder: number;
    options: Array<{
      id: string;
      optionText: string;
      optionOrder: number;
      isCorrect: boolean;
    }>;
  }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid() {
  return Math.random().toString(36).slice(2);
}

function blankOption(): OptionDraft {
  return { id: uid(), optionText: "", isCorrect: false };
}

function blankQuestion(): QuestionDraft {
  return {
    id: uid(),
    questionText: "",
    options: [blankOption(), blankOption(), blankOption(), blankOption()],
  };
}

async function fetchQuiz(lessonId: string): Promise<QuizData | null> {
  const token = getAuthToken();
  const res = await apiFetch(`/api/lessons/${lessonId}/quiz`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Failed to load quiz");
  return res.json();
}

async function saveQuiz(
  lessonId: string,
  passingScore: number,
  questions: QuestionDraft[]
): Promise<{ progressReset?: boolean }> {
  const token = getAuthToken();
  const res = await apiFetch(`/api/lessons/${lessonId}/quiz`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      passingScore,
      questions: questions.map((q) => ({
        questionText: q.questionText,
        options: q.options.map((o) => ({
          optionText: o.optionText,
          isCorrect: o.isCorrect,
        })),
      })),
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Save failed");
  }
  return res.json();
}

async function deleteQuiz(lessonId: string): Promise<void> {
  const token = getAuthToken();
  const res = await apiFetch(`/api/lessons/${lessonId}/quiz`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Could not delete quiz");
}

// ─── Main component ───────────────────────────────────────────────────────────

export function QuizEditor({ lessonId }: { lessonId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [passingScore, setPassingScore] = useState(70);
  const [questions, setQuestions] = useState<QuestionDraft[]>([]);
  const [initialised, setInitialised] = useState(false);

  const queryKey = ["quiz", lessonId];

  const { data: quiz, isLoading } = useQuery({
    queryKey,
    queryFn: () => fetchQuiz(lessonId),
    enabled: open,
    staleTime: 60_000,
  });

  // Seed draft state when quiz loads
  if (quiz && !initialised) {
    setPassingScore(quiz.passingScore);
    setQuestions(
      quiz.questions.map((q) => ({
        id: q.id,
        questionText: q.questionText,
        options: q.options.map((o) => ({
          id: o.id,
          optionText: o.optionText,
          isCorrect: o.isCorrect,
        })),
      }))
    );
    setInitialised(true);
  }

  // Reset draft when panel closes
  const handleToggle = () => {
    if (open) {
      setInitialised(false);
      setQuestions([]);
    }
    setOpen((v) => !v);
  };

  const saveMutation = useMutation({
    mutationFn: () => saveQuiz(lessonId, passingScore, questions),
    onSuccess: result => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ["courses"] });
      queryClient.invalidateQueries({ queryKey: ["lessons"] });
      queryClient.invalidateQueries({ queryKey: ["student"] });
      queryClient.invalidateQueries({ queryKey: ["certificates"] });
      queryClient.invalidateQueries({ queryKey: ["admin"] });
      toast({ title: "Quiz saved", description: result.progressReset ? "Students must pass the updated quiz to complete this lesson." : undefined });
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Save failed", description: (err as Error).message });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteQuiz(lessonId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setQuestions([]);
      setInitialised(false);
      toast({ title: "Quiz removed" });
    },
  });

  // ── Question helpers ────────────────────────────────────────────────────────

  const addQuestion = () => setQuestions((prev) => [...prev, blankQuestion()]);

  const removeQuestion = (qId: string) =>
    setQuestions((prev) => prev.filter((q) => q.id !== qId));

  const updateQuestionText = (qId: string, text: string) =>
    setQuestions((prev) =>
      prev.map((q) => (q.id === qId ? { ...q, questionText: text } : q))
    );

  const updateOptionText = (qId: string, oId: string, text: string) =>
    setQuestions((prev) =>
      prev.map((q) =>
        q.id === qId
          ? {
              ...q,
              options: q.options.map((o) =>
                o.id === oId ? { ...o, optionText: text } : o
              ),
            }
          : q
      )
    );

  const setCorrectOption = (qId: string, oId: string) =>
    setQuestions((prev) =>
      prev.map((q) =>
        q.id === qId
          ? {
              ...q,
              options: q.options.map((o) => ({
                ...o,
                isCorrect: o.id === oId,
              })),
            }
          : q
      )
    );

  const addOption = (qId: string) =>
    setQuestions((prev) =>
      prev.map((q) =>
        q.id === qId && q.options.length < 6
          ? { ...q, options: [...q.options, blankOption()] }
          : q
      )
    );

  const removeOption = (qId: string, oId: string) =>
    setQuestions((prev) =>
      prev.map((q) =>
        q.id === qId && q.options.length > 2
          ? { ...q, options: q.options.filter((o) => o.id !== oId) }
          : q
      )
    );

  // ── Validation ──────────────────────────────────────────────────────────────

  const validate = (): string | null => {
    if (questions.length === 0) return "Add at least one question";
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.questionText.trim()) return `Question ${i + 1} needs text`;
      const filled = q.options.filter((o) => o.optionText.trim());
      if (filled.length < 2) return `Question ${i + 1} needs at least 2 answer options`;
      if (!q.options.some((o) => o.isCorrect))
        return `Question ${i + 1} needs a correct answer marked`;
    }
    return null;
  };

  const handleSave = () => {
    const err = validate();
    if (err) {
      toast({ variant: "destructive", title: "Fix before saving", description: err });
      return;
    }
    saveMutation.mutate();
  };

  const hasQuiz = quiz !== null && quiz !== undefined;

  return (
    <div className="border-t mt-4 pt-4">
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center justify-between text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <span className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4" />
          Lesson Quiz
          {hasQuiz && (
            <Badge variant="secondary" className="text-xs">
              {quiz.questions.length} question{quiz.questions.length !== 1 ? "s" : ""}
            </Badge>
          )}
          {!hasQuiz && !isLoading && open && (
            <Badge variant="outline" className="text-xs text-muted-foreground">
              None
            </Badge>
          )}
        </span>
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>

      {open && (
        <div className="mt-4 space-y-6">
          {isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading quiz…
            </div>
          ) : (
            <>
              {/* Passing score */}
              <div className="flex items-center gap-3 max-w-xs">
                <Label htmlFor={`ps-${lessonId}`} className="shrink-0 text-sm">
                  Passing score (%)
                </Label>
                <Input
                  id={`ps-${lessonId}`}
                  type="number"
                  min={1}
                  max={100}
                  value={passingScore}
                  onChange={(e) => setPassingScore(Number(e.target.value))}
                  className="w-24"
                />
              </div>

              {/* Questions */}
              <div className="space-y-4">
                {questions.map((q, qi) => (
                  <Card key={q.id} className="border-dashed">
                    <CardHeader className="pb-2 pt-3 px-4">
                      <div className="flex items-start gap-2">
                        <CardTitle className="text-sm font-medium flex-1">
                          <Input
                            value={q.questionText}
                            onChange={(e) => updateQuestionText(q.id, e.target.value)}
                            placeholder={`Question ${qi + 1}`}
                            className="font-medium text-sm"
                          />
                        </CardTitle>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => removeQuestion(q.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent className="px-4 pb-3 space-y-2">
                      {q.options.map((o) => (
                        <div key={o.id} className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setCorrectOption(q.id, o.id)}
                            className={`shrink-0 h-5 w-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                              o.isCorrect
                                ? "border-primary bg-primary text-white"
                                : "border-muted-foreground/30 hover:border-primary/50"
                            }`}
                            title="Mark as correct answer"
                          >
                            {o.isCorrect && <CheckCircle className="h-3 w-3" />}
                          </button>
                          <Input
                            value={o.optionText}
                            onChange={(e) => updateOptionText(q.id, o.id, e.target.value)}
                            placeholder="Answer option…"
                            className="text-sm h-8"
                          />
                          {q.options.length > 2 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                              onClick={() => removeOption(q.id, o.id)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      ))}
                      {q.options.length < 6 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-xs text-muted-foreground h-7 mt-1"
                          onClick={() => addOption(q.id)}
                        >
                          <Plus className="h-3 w-3 mr-1" /> Add option
                        </Button>
                      )}
                    </CardContent>
                  </Card>
                ))}

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full border-dashed"
                  onClick={addQuestion}
                >
                  <Plus className="h-4 w-4 mr-2" /> Add question
                </Button>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-between pt-2 border-t">
                {hasQuiz ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => deleteMutation.mutate()}
                    disabled={deleteMutation.isPending}
                  >
                    {deleteMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <Trash2 className="h-4 w-4 mr-2" />
                    )}
                    Remove Quiz
                  </Button>
                ) : (
                  <span />
                )}
                <Button
                  type="button"
                  size="sm"
                  onClick={handleSave}
                  disabled={saveMutation.isPending || questions.length === 0}
                >
                  {saveMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : null}
                  Save Quiz
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
