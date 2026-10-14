import { apiFetch } from "@/lib/api-client";
import { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { 
  useGetCourse, 
  useGetLesson, 
  useCompleteLesson,
  useCompleteLessonPart,
  getGetCourseQueryKey,
  getGetLessonQueryKey,
  getListLessonsQueryKey,
  getGetCourseProgressQueryKey,
  getGetStudentStatsQueryKey,
  getGetMyProgressQueryKey,
  downloadLessonPart,
  downloadLesson,
  saveDownloadedFile,
  saveFilesAsZip,
} from "@/lib/api-client";
import { StudentLayout } from "@/components/layout/student-layout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, ChevronRight, CheckCircle, ClipboardList, FileText, Play, ArrowLeft, Lock, ExternalLink, Download, Eye } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Separator } from "@/components/ui/separator";
import { QuizModal } from "@/components/quiz-modal";
import { getAuthToken } from "@/lib/api-client";
import { formatDuration } from "@/lib/duration";

async function fetchLessonQuiz(lessonId: string) {
  const token = getAuthToken();
  const res = await apiFetch(`/api/lessons/${lessonId}/quiz`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Failed to load quiz");
  return res.json();
}

async function fetchBestAttempt(lessonId: string) {
  const token = getAuthToken();
  const res = await apiFetch(`/api/lessons/${lessonId}/quiz/best-attempt`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { hasPassed: false, bestScore: null };
  return res.json();
}

// ---------------------------------------------------------------------------
// External-link / embed detection helpers
// ---------------------------------------------------------------------------

const VIDEO_FILE_EXTS = [".mp4", ".webm", ".mov", ".ogg", ".m3u8", ".mkv"];
const AUDIO_FILE_EXTS = [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"];
const PDF_FILE_EXTS = [".pdf"];

function hasExtension(url: string, exts: string[]): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return exts.some((ext) => path.endsWith(ext));
  } catch {
    return false;
  }
}

/** Returns an embeddable Google Drive preview URL for a shared file link. */
function getGoogleDrivePreview(url: string): string | null {
  const fileId = url.match(/drive\.google\.com\/(?:file\/d\/|open\?[^#]*\bid=|uc\?[^#]*\bid=)([\w-]+)/)?.[1];
  return fileId ? `https://drive.google.com/file/d/${fileId}/preview` : null;
}

/** Returns a YouTube/Vimeo embed URL if the link matches, otherwise null. */
function getVideoPlatformEmbed(url: string): string | null {
  const yt = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([\w-]{6,})/
  );
  if (yt) return `https://www.youtube.com/embed/${yt[1]}`;

  const vimeo = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}`;

  return getGoogleDrivePreview(url);
}

/** Returns a Spotify/SoundCloud embed URL if the link matches, otherwise null. */
function getAudioPlatformEmbed(url: string): string | null {
  const spotify = url.match(/open\.spotify\.com\/(track|episode|album|playlist)\/([\w]+)/);
  if (spotify) return `https://open.spotify.com/embed/${spotify[1]}/${spotify[2]}`;

  if (/soundcloud\.com\//.test(url)) {
    return `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&auto_play=false&color=%23ff5500`;
  }

  const drivePreview = getGoogleDrivePreview(url);
  if (drivePreview) return drivePreview;

  const ytEmbed = getVideoPlatformEmbed(url);
  if (ytEmbed) return ytEmbed;

  return null;
}
/** Returns a preview/embed URL for common document-hosting links (Google Drive, Dropbox). */
function getDocPlatformEmbed(url: string): string | null {
  const drivePreview = getGoogleDrivePreview(url);
  if (drivePreview) return drivePreview;

  if (/dropbox\.com\//.test(url)) {
    const raw = url.replace(/\?dl=0$/, "?raw=1").replace(/\?dl=1$/, "?raw=1");
    return `https://docs.google.com/viewer?url=${encodeURIComponent(raw)}&embedded=true`;
  }

  return null;
}

type MediaResolution =
  | { kind: "direct"; url: string }
  | { kind: "embed"; url: string }
  | { kind: "unknown"; url: string };

function resolveVideo(url: string): MediaResolution {
  if (hasExtension(url, VIDEO_FILE_EXTS)) return { kind: "direct", url };
  const embed = getVideoPlatformEmbed(url);
  if (embed) return { kind: "embed", url: embed };
  return { kind: "unknown", url };
}

function resolveAudio(url: string): MediaResolution {
  if (hasExtension(url, AUDIO_FILE_EXTS)) return { kind: "direct", url };
  const embed = getAudioPlatformEmbed(url);
  if (embed) return { kind: "embed", url: embed };
  return { kind: "unknown", url };
}

function resolveDoc(url: string): MediaResolution {
  if (hasExtension(url, PDF_FILE_EXTS)) return { kind: "direct", url };
  const embed = getDocPlatformEmbed(url);
  if (embed) return { kind: "embed", url: embed };
  // Last resort: try Google Docs Viewer on the raw url — works for many
  // publicly accessible pdf/doc links that don't match a known platform.
  return { kind: "embed", url: `https://docs.google.com/viewer?url=${encodeURIComponent(url)}&embedded=true` };
}

// A small manual "mark as finished" control shown under embeds where we
// can't reliably detect completion (cross-origin iframes don't expose
// ended/progress events the way native <video>/<audio> tags do).
function openOriginalLink(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function ManualFinishControl(_: {
  label: string;
  originalUrl: string;
  onFinish: () => void;
  finished: boolean;
}) {
  // Completion is tracked automatically; keep the component non-rendering so
  // older embed branches cannot expose a manual completion control.
  return null;
}

export default function LessonPlayer({ params }: { params: { id: string, lessonId: string } }) {
  const { id: courseId, lessonId } = params;
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [quizModalOpen, setQuizModalOpen] = useState(false);
  const [activePartIndex, setActivePartIndex] = useState(0);
  const [completedPartIds, setCompletedPartIds] = useState<Set<string>>(new Set());
  const [downloadingPartId, setDownloadingPartId] = useState<string | null>(null);

  const { data: course, isLoading: isCourseLoading, isError: courseFailed, refetch: refetchCourse } = useGetCourse(courseId, {
    query: { enabled: !!courseId, queryKey: getGetCourseQueryKey(courseId) }
  });

  const { data: lesson, isLoading: isLessonLoading, isError: lessonFailed, error: lessonError, refetch: refetchLesson } = useGetLesson(lessonId, {
    query: { enabled: !!lessonId, queryKey: getGetLessonQueryKey(lessonId) }
  });

  // Quiz data for this lesson
  const { data: quiz, isPending: isQuizLoading } = useQuery({
    queryKey: ["lesson-quiz", lessonId],
    queryFn: () => fetchLessonQuiz(lessonId),
    enabled: !!lessonId,
    staleTime: 60_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const { data: bestAttempt, refetch: refetchBestAttempt } = useQuery({
    queryKey: ["quiz-best-attempt", lessonId],
    queryFn: () => fetchBestAttempt(lessonId),
    enabled: !!lessonId && !!quiz,
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  // Wait for this check before auto-completing, so a required quiz can never
  // be bypassed by a fast media-end event.
  const hasQuiz = quiz !== null && quiz !== undefined;
  const quizPassed = bestAttempt?.hasPassed === true;

  const completeMutation = useCompleteLesson();
  const completePartMutation = useCompleteLessonPart();

  useEffect(() => {
    setActivePartIndex(0);
  }, [lessonId]);

  // Find current lesson in course lessons to check status and get neighbors
  const courseLesson = course?.lessons?.find(l => l.id === lessonId);
  const isCompleted = courseLesson?.isCompleted || false;
  const lessonParts = lesson?.parts && lesson.parts.length > 0
    ? lesson.parts
    : lesson ? [{
        title: lesson.title,
        contentType: lesson.contentType,
        fileUrl: lesson.fileUrl,
        duration: lesson.duration ?? null,
      }] : [];

  useEffect(() => {
    if (!lesson) return;
    const partIds = lessonParts.map((part, index) => part.partId ?? `legacy-${lesson.id}-${index}`);
    setCompletedPartIds(
      isCompleted
        ? new Set(partIds)
        : new Set(lesson.completedPartIds ?? []),
    );
  }, [isCompleted, lesson, lessonParts.length]);
  
  // Find prev/next navigation
  const currentIndex = course?.lessons?.findIndex(l => l.id === lessonId) ?? -1;
  const prevLesson = currentIndex > 0 ? course?.lessons?.[currentIndex - 1] : null;
  const nextLesson = currentIndex < (course?.lessons?.length || 0) - 1 ? course?.lessons?.[currentIndex + 1] : null;

  // Handle lesson lock state
  useEffect(() => {
    if (courseLesson?.isLocked) {
      toast({
        variant: "destructive",
        title: "Lesson Locked",
        description: "You must complete previous lessons first.",
      });
      setLocation(`/courses/${courseId}`);
    }
  }, [courseLesson?.isLocked, courseId, setLocation, toast]);

  const handleComplete = () => {
  if (isCompleted || completeMutation.isPending) return;

  completeMutation.mutate({ id: lessonId, data: { lessonUpdatedAt: lesson?.updatedAt } }, {
    onSuccess: () => {
      toast({
        title: "Lesson Completed!",
        description: "Great job. Keep up the momentum.",
      });
      queryClient.invalidateQueries({ queryKey: getGetCourseQueryKey(courseId) });
      queryClient.invalidateQueries({ queryKey: ["courses", courseId, "downloads"] });
      queryClient.invalidateQueries({ queryKey: getListLessonsQueryKey(courseId) });
      queryClient.invalidateQueries({ queryKey: getGetCourseProgressQueryKey(courseId) });
      queryClient.invalidateQueries({ queryKey: getGetStudentStatsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetMyProgressQueryKey() });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Could not complete lesson",
        description: error?.message ?? "Please try again.",
      });
    },
  });
};
  // Called when content finishes — if quiz exists show Take Quiz, else mark complete
  const handlePartFinished = (partIndex = activePartIndex) => {
    const part = lessonParts[partIndex];
    const partId = part?.partId ?? `legacy-${lessonId}-${partIndex}`;
    completePartMutation.mutate({ id: lessonId, partId, lessonUpdatedAt: lesson?.updatedAt }, {
      onSuccess: result => {
        const next = new Set(result.completedPartIds);
        setCompletedPartIds(next);
        if (next.size >= Math.max(lessonParts.length, 1) && !isQuizLoading && !hasQuiz && !isCompleted) handleComplete();
      },
      onError: (error: any) => {
        queryClient.invalidateQueries({ queryKey: getGetLessonQueryKey(lessonId) });
        queryClient.invalidateQueries({ queryKey: getGetCourseQueryKey(courseId) });
        toast({ variant: "destructive", title: "Could not save progress", description: error?.message ?? "Please try again." });
      },
    });
  };

  const handleDownloadPart = async (part: any, partIndex: number) => {
    const partId = part.partId ?? `legacy-${lessonId}-${partIndex}`;
    if (part.isDownloadable === false) {
      toast({ title: "Streaming only", description: "This part is hosted on YouTube. Please watch it here to continue." });
      return;
    }
    setDownloadingPartId(partId);
    try {
      const { blob, filename } = await downloadLessonPart(lessonId, partId, part.title || lesson?.title);
      saveDownloadedFile(blob, filename);
      setCompletedPartIds((previous) => new Set(previous).add(partId));
      queryClient.invalidateQueries({ queryKey: getGetLessonQueryKey(lessonId) });
      toast({ title: "Download started", description: "This part has been marked as read. Complete the quiz if one is required." });
    } catch (error: any) {
      toast({ variant: "destructive", title: "Could not download", description: error?.message ?? "Please try again." });
    } finally {
      setDownloadingPartId(null);
    }
  };

  const handleDownloadLesson = async () => {
    setDownloadingPartId("lesson-zip");
    try {
      const { blob, filename } = await downloadLesson(lessonId, lesson?.title);
      saveDownloadedFile(blob, filename);
      queryClient.invalidateQueries({ queryKey: getGetLessonQueryKey(lessonId) });
      toast({ title: "Lesson ZIP download started", description: "The lesson parts are arranged and named inside the ZIP. Complete any required quiz to finish the lesson." });
    } catch (error: any) {
      toast({ variant: "destructive", title: "Could not download lesson", description: error?.message ?? "Please try again." });
    } finally {
      setDownloadingPartId(null);
    }
  };

  // Called by quiz modal when student passes
  const handleQuizPassed = () => {
    setQuizModalOpen(false);
    refetchBestAttempt();
    handleComplete();
  };

  const handleVideoEnded = () => {
    handlePartFinished();
  };

  // Iframes and PDFs cannot provide a reliable completion event. For these,
  // only focused, visible time counts. Native audio/video use their real end
  // event above.
  useEffect(() => {
    const activePart = lessonParts[activePartIndex];
    if (!activePart || isCompleted || completedPartIds.has(activePart.partId ?? `legacy-${lessonId}-${activePartIndex}`) || isQuizLoading) return;

    const isNativeMedia = activePart.contentType === "video"
      ? resolveVideo(activePart.fileUrl).kind === "direct"
      : activePart.contentType === "audio" && resolveAudio(activePart.fileUrl).kind === "direct";
    if (isNativeMedia) return;

    const duration = activePart.duration ?? lesson?.duration ?? 60;
    const requiredSeconds = Math.max(1, Math.ceil(duration * 0.9));
    let watchedSeconds = 0;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      watchedSeconds += 1;
      if (watchedSeconds >= requiredSeconds) handlePartFinished(activePartIndex);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [activePartIndex, completedPartIds, isCompleted, isQuizLoading, lesson?.duration, lesson?.id, lesson?.parts]);

  if (courseFailed || lessonFailed) {
    const message = lessonError && typeof lessonError === "object" && "message" in lessonError ? String(lessonError.message) : "The lesson could not be loaded. Please try again.";
    return <StudentLayout><div className="mx-auto max-w-lg py-12 text-center space-y-4" role="alert">
      <h1 className="text-xl font-semibold">Lesson unavailable</h1><p className="text-muted-foreground">{message}</p>
      <div className="flex justify-center gap-3"><Link href={`/courses/${courseId}`}><Button>Back to course</Button></Link>
        <Button variant="outline" onClick={() => { refetchCourse(); refetchLesson(); }}>Retry</Button></div>
    </div></StudentLayout>;
  }

  if (isCourseLoading || isLessonLoading || !course || !lesson) {
    return (
      <div className="min-h-screen bg-background flex flex-col">
        <header className="h-16 border-b flex items-center px-6">
          <Skeleton className="h-8 w-8 rounded-full" />
          <Skeleton className="h-6 w-48 ml-4" />
        </header>
        <main className="flex-1 container mx-auto px-4 py-8 max-w-5xl">
          <Skeleton className="w-full aspect-video rounded-xl mb-8" />
          <Skeleton className="h-10 w-3/4 mb-4" />
          <Skeleton className="h-24 w-full" />
        </main>
      </div>
    );
  }

  if (courseLesson?.isLocked) {
    return null; // Will redirect via useEffect
  }

  if (lessonParts.length === 0) {
    return (
      <div className="min-h-[100dvh] bg-background flex flex-col items-center justify-center p-6 text-center">
        <FileText className="h-10 w-10 text-muted-foreground mb-4" />
        <h1 className="text-xl font-semibold">This lesson has no content yet</h1>
        <p className="text-muted-foreground mt-2 max-w-md">
          Please return to the course and choose another lesson, or contact your course administrator.
        </p>
        <Link href={`/courses/${courseId}`} className="mt-6">
          <Button>Back to course</Button>
        </Link>
      </div>
    );
  }

  const activePart = lessonParts[Math.min(activePartIndex, lessonParts.length - 1)]!;
  const allPartsFinished = completedPartIds.size >= lessonParts.length;
  const activePartFinished = completedPartIds.has(activePart.partId ?? `legacy-${lessonId}-${activePartIndex}`);
  const downloadablePartCount = lessonParts.filter((part) => part.isDownloadable !== false).length;

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col">
      {/* Immersive Header */}
      <header className="min-h-16 border-b bg-card sticky top-0 z-10 flex items-center gap-2 px-3 py-2 sm:px-4 md:px-6 justify-between">
        <div className="flex flex-1 items-center gap-2 sm:gap-4 min-w-0">
          <Link href={`/courses/${courseId}`}>
            <Button variant="ghost" size="icon" className="shrink-0 rounded-full hover:bg-muted">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <Separator orientation="vertical" className="h-6 hidden md:block" />
          <div className="flex items-center gap-2 min-w-0 text-sm font-medium">
            <span className="text-muted-foreground hidden md:inline truncate">{course.title}</span>
            <span className="text-muted-foreground hidden md:inline">/</span>
            <span className="truncate max-w-[200px] md:max-w-[400px]">{lesson.title}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isCompleted ? (
            <div className="flex items-center gap-2 text-green-600 dark:text-green-500 bg-green-500/10 px-3 py-1.5 rounded-full text-sm font-medium">
              <CheckCircle className="h-4 w-4" />
              <span className="hidden sm:inline">Completed</span>
            </div>
          ) : hasQuiz ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setQuizModalOpen(true)}
              disabled={!allPartsFinished && !quizPassed}
              className={`gap-2 rounded-full ${
                quizPassed
                  ? "border-primary/20 hover:bg-primary/5 hover:text-primary"
                  : "border-amber-400/40 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-950/30 dark:text-amber-400"
              }`}
            >
              <ClipboardList className="h-4 w-4" />
              <span className="hidden sm:inline">
                {quizPassed ? "Retake Quiz" : allPartsFinished ? "Take Quiz" : "Finish Parts"}
              </span>
            </Button>
          ) : (
            <div className="text-xs text-muted-foreground" aria-live="polite">
              {isQuizLoading ? "Checking lesson requirements…" : "Completion is tracked automatically"}
            </div>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 bg-slate-50 dark:bg-slate-950">
        <div className="max-w-6xl mx-auto py-4 sm:py-6 md:py-8 px-3 sm:px-4 md:px-8">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
          {/* Player Container */}
          <div className="bg-card border shadow-sm rounded-xl sm:rounded-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-500">
            {activePart.contentType === "video" && (() => {
              const resolved = resolveVideo(activePart.fileUrl);
              return (
                <div className="flex flex-col">
                  <div className="aspect-video w-full min-h-[220px] bg-black relative group sm:min-h-[320px]">
                    {resolved.kind === "direct" ? (
                      <video
                        key={`${lesson.id}-${activePartIndex}-${activePart.fileUrl}`}
                        ref={videoRef}
                        src={resolved.url}
                        controls
                        controlsList="nodownload"
                        className="w-full h-full object-contain"
                        onEnded={handleVideoEnded}
                        poster={course.thumbnailUrl || undefined}
                      >
                        Your browser does not support the video tag.
                      </video>
                    ) : (
                      <iframe
                        key={`${lesson.id}-${activePartIndex}-${resolved.url}`}
                        src={resolved.url}
                        className="w-full h-full"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        allowFullScreen
                        title={activePart.title}
                      />
                    )}
                  </div>
                  {/* Embeds (YouTube/Vimeo/unknown) can't reliably signal "ended" across
                      origins, so give the learner a manual way to mark this part finished. */}
                  {resolved.kind !== "direct" && !activePartFinished && (
                    <ManualFinishControl
                      label={hasQuiz ? "I've watched this — continue" : "Mark as watched"}
                      originalUrl={activePart.fileUrl}
                      finished={activePartFinished}
                      onFinish={() => handlePartFinished()}
                    />
                  )}
                </div>
              );
            })()}

            {activePart.contentType === "audio" && (() => {
              const resolved = resolveAudio(activePart.fileUrl);
              return (
                <div className="flex flex-col">
                  <div className="p-6 sm:p-10 md:p-16 flex min-h-[300px] flex-col items-center justify-center bg-slate-900 text-white">
                    <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-primary/20 sm:mb-7 sm:h-20 sm:w-20 pulse-ring">
                      <Play className="h-7 w-7 text-primary ml-1 sm:h-8 sm:w-8" />
                    </div>
                    <h3 className="mb-5 text-center text-lg font-medium sm:mb-7 sm:text-xl">{activePart.title}</h3>
                    {resolved.kind === "direct" ? (
                      <audio
                        key={`${lesson.id}-${activePartIndex}-${activePart.fileUrl}`}
                        ref={audioRef}
                        src={resolved.url}
                        controls
                        controlsList="nodownload"
                        className="w-full max-w-xl"
                        onEnded={() => handlePartFinished()}
                      >
                        Your browser does not support the audio element.
                      </audio>
                    ) : (
                      <iframe
                        key={`${lesson.id}-${activePartIndex}-${resolved.url}`}
                        src={resolved.url}
                        className="w-full max-w-xl rounded-lg"
                        height={resolved.url.includes("spotify") ? 152 : 166}
                        allow="autoplay; clipboard-write; encrypted-media"
                        title={activePart.title}
                      />
                    )}
                  </div>
                  {resolved.kind !== "direct" && !activePartFinished && (
                    <ManualFinishControl
                      label={hasQuiz ? "I've listened — continue" : "Mark as listened"}
                      originalUrl={activePart.fileUrl}
                      finished={activePartFinished}
                      onFinish={() => handlePartFinished()}
                    />
                  )}
                </div>
              );
            })()}

            {activePart.contentType === "pdf" && (() => {
              const resolved = resolveDoc(activePart.fileUrl);
              // Keep the browser/PDF controls visible. They provide the most
              // reliable zoom and touch-scroll behaviour on phones and tablets.
              const iframeSrc = resolved.kind === "direct" ? `${resolved.url}#view=FitH` : resolved.url;
              return (
                <div className="flex h-[62dvh] min-h-[360px] w-full flex-col bg-muted sm:h-[70vh] sm:min-h-[560px]">
                  <div className="flex shrink-0 items-center justify-between gap-3 border-b bg-card px-3 py-2 sm:px-4">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{activePart.title}</p>
                      <p className="text-xs text-muted-foreground">Scroll, zoom, or open the document in a new tab.</p>
                    </div>
                    <a href={activePart.fileUrl} target="_blank" rel="noopener noreferrer" className="shrink-0">
                      <Button type="button" variant="outline" size="sm" className="gap-1.5">
                        <ExternalLink className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Open</span>
                      </Button>
                    </a>
                  </div>
                  <iframe 
                    src={iframeSrc} 
                    className="min-h-0 flex-1 w-full touch-pan-y"
                    title={activePart.title}
                    scrolling="yes"
                    allowFullScreen
                  />
                  {false && !activePartFinished && (
                    <div className="p-4 bg-card border-t flex items-center justify-between gap-3">
                      <a
                        href={activePart.fileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(event) => {
                          event.preventDefault();
                          openOriginalLink(activePart.fileUrl);
                        }}
                        className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Open original link
                      </a>
                      {hasQuiz ? (
                        <Button
                          onClick={() => handlePartFinished()}
                          className="gap-2 shadow-sm"
                        >
                          <ClipboardList className="h-4 w-4" />
                          I've Read This — Take Quiz
                        </Button>
                      ) : (
                        <Button 
                          onClick={() => handlePartFinished()} 
                          disabled={completeMutation.isPending}
                          className="gap-2 shadow-sm"
                        >
                          <CheckCircle className="h-4 w-4" />
                          Mark as Read
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          <aside className="order-first lg:order-none rounded-xl border bg-card p-3 shadow-sm lg:sticky lg:top-20">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Lesson parts</h2>
                <p className="text-xs text-muted-foreground">Choose a part to start learning.</p>
              </div>
              <span className="text-xs font-medium text-muted-foreground">{activePartIndex + 1}/{lessonParts.length}</span>
            </div>
            <div className="grid max-h-44 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:max-h-52 lg:max-h-[calc(100vh-9rem)]">
              {lessonParts.map((part, index) => {
                const partId = part.partId ?? `legacy-${lessonId}-${index}`;
                const selected = index === activePartIndex;
                return (
                  <button key={partId} type="button" onClick={() => setActivePartIndex(index)} aria-current={selected ? "step" : undefined}
                    className={`flex min-w-0 items-center gap-3 rounded-lg border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "border-primary bg-primary/10" : "hover:bg-muted/60"}`}>
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-semibold text-primary">
                      {completedPartIds.has(partId) ? <CheckCircle className="h-4 w-4" /> : index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{part.title}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground capitalize">{part.contentType}{part.duration ? ` · ${formatDuration(part.duration)}` : ""}</span>
                    </span>
                    {part.isDownloadable === false ? <Eye className="h-4 w-4 shrink-0 text-muted-foreground" /> : <Download className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  </button>
                );
              })}
            </div>
          </aside>
          </div>

          {/* Lesson Metadata & Navigation */}
          <div className="mt-6 flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
            <div className="space-y-4 max-w-2xl">
              <h1 className="text-2xl md:text-3xl font-bold tracking-tight">{lesson.title}</h1>
              <div className="prose dark:prose-invert max-w-none text-muted-foreground">
                <p>Welcome to lesson {lesson.lessonOrder}. Make sure to go through all the material carefully before proceeding.</p>
              </div>

              <div className="flex flex-wrap gap-2">
                {downloadablePartCount > 0 && (
                  <Button variant="outline" size="sm" className="gap-2" onClick={handleDownloadLesson} disabled={downloadingPartId !== null}>
                    <Download className="h-4 w-4" /> {downloadingPartId === "lesson-zip" ? "Preparing lesson ZIP..." : `Download lesson ZIP (${downloadablePartCount})`}
                  </Button>
                )}
                {activePart.isDownloadable === false ? (
                  <Button variant="outline" size="sm" disabled className="gap-2">
                    <Eye className="h-4 w-4" /> Streaming only (YouTube)
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" className="gap-2" onClick={() => handleDownloadPart(activePart, activePartIndex)} disabled={downloadingPartId !== null}>
                    <Download className="h-4 w-4" /> {downloadingPartId === (activePart.partId ?? `legacy-${lessonId}-${activePartIndex}`) ? "Downloading..." : "Download this part"}
                  </Button>
                )}
              </div>

              {lessonParts.length > 0 && (
                <div className="hidden rounded-xl border bg-card p-4">
                  <h2 className="text-sm font-semibold mb-3">Lesson parts</h2>
                  <div className="space-y-3">
                    {lessonParts.map((part, index) => (
                      <button
                        key={`${part.title}-${index}`}
                        type="button"
                        onClick={() => setActivePartIndex(index)}
                        className={`w-full text-left flex gap-3 rounded-lg border p-3 transition-colors ${
                          index === activePartIndex ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                        }`}
                      >
                        <div className="h-7 w-7 rounded-md bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold shrink-0">
                          {completedPartIds.has(part.partId ?? `legacy-${lessonId}-${index}`) ? <CheckCircle className="h-4 w-4" /> : index + 1}
                        </div>
                        <div className="min-w-0 flex-1 text-left">
                          <h3 className="text-sm font-medium text-foreground">{part.title}</h3>
                          {part.description && (
                            <p className="text-sm text-muted-foreground mt-1">{part.description}</p>
                          )}
                          <p className="text-xs text-muted-foreground mt-1 capitalize">
                            {part.contentType}
                            {part.duration ? ` · ${formatDuration(part.duration)}` : ""}
                          </p>
                        </div>
                        {part.isDownloadable === false ? <Eye className="h-4 w-4 text-muted-foreground shrink-0" aria-label="Streaming only" /> : <Download className="h-4 w-4 text-muted-foreground shrink-0" aria-label="Downloadable" />}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Quiz CTA — shown when lesson has a quiz and content type is video/audio (PDF has its own inline button) */}
              {hasQuiz && allPartsFinished && !isCompleted && (
                <div className="flex items-center gap-3 rounded-xl border border-amber-300/50 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-700/30 px-4 py-3">
                  <ClipboardList className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                      {quizPassed ? "You passed the quiz!" : "This lesson has a quiz"}
                    </p>
                    <p className="text-xs text-amber-600 dark:text-amber-500 mt-0.5">
                      {quizPassed
                        ? "Your lesson is being marked complete automatically."
                        : `Pass the quiz (${quiz?.passingScore ?? 70}% or above) to complete this lesson.`}
                    </p>
                  </div>
                  {!quizPassed && (
                    <Button size="sm" onClick={() => setQuizModalOpen(true)} className="shrink-0 bg-amber-600 hover:bg-amber-700 text-white">
                      Take Quiz
                    </Button>
                  )}
                </div>
              )}
            </div>

            {/* Navigation Controls */}
            <div className="flex w-full md:w-auto gap-3 shrink-0">
              <Button 
                variant="outline" 
                className="flex-1 md:flex-none h-12 px-6 rounded-full"
                disabled={!prevLesson}
                onClick={() => prevLesson && setLocation(`/courses/${courseId}/lessons/${prevLesson.id}`)}
              >
                <ChevronLeft className="h-5 w-5 mr-1" /> Previous
              </Button>
              
              <Button 
                className="flex-1 md:flex-none h-12 px-6 rounded-full shadow-md"
                disabled={!nextLesson || (nextLesson.isLocked && !isCompleted)}
                onClick={() => nextLesson && setLocation(`/courses/${courseId}/lessons/${nextLesson.id}`)}
              >
                Next <ChevronRight className="h-5 w-5 ml-1" />
              </Button>
            </div>
          </div>
        </div>
      </main>

      {/* Quiz Modal */}
      {hasQuiz && quiz && (
        <QuizModal
          open={quizModalOpen}
          onClose={() => setQuizModalOpen(false)}
          quiz={quiz}
          lessonId={lessonId}
          onPassed={handleQuizPassed}
        />
      )}
    </div>
  );
}
