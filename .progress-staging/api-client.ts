import { useMutation, useQuery } from "@tanstack/react-query";
import JSZip from "jszip";

export type ManagedUser = {
  id: string;
  fullname: string;
  email: string;
  role: "student" | "admin";
  status: "active" | "suspended";
  avatarUrl: string | null;
  createdAt: string;
  enrolledCourses: number;
  completedLessons: number;
};

export function useCreateUser() {
  return useMutation({ mutationFn: ({ data }: { data: { fullname: string; email: string; password: string; role: "student" | "admin" } }) =>
    apiRequest<ManagedUser>("/api/admin/users", { method: "POST", body: JSON.stringify(data) }) });
}

export function useDeleteUser() {
  return useMutation({ mutationFn: ({ id }: { id: string }) =>
    apiRequest<void>(`/api/admin/users/${id}`, { method: "DELETE" }) });
}

export function useUpdateUserRole() {
  return useMutation({ mutationFn: ({ id, role }: { id: string; role: "student" | "admin" }) =>
    apiRequest<ManagedUser>(`/api/admin/users/${id}/role`, { method: "PATCH", body: JSON.stringify({ role }) }) });
}

export function useChangePassword() {
  return useMutation({ mutationFn: (data: { currentPassword: string; newPassword: string }) =>
    apiRequest<{ token: string; message: string }>("/api/auth/password", { method: "POST", body: JSON.stringify(data) }) });
}

export type UserFilters = { page: number; limit: number; search: string; role: string; status: string };
export function usePaginatedUsers(filters: UserFilters) {
  const query = new URLSearchParams({ page: String(filters.page), limit: String(filters.limit) });
  if (filters.search) query.set("search", filters.search);
  if (filters.role !== "all") query.set("role", filters.role);
  if (filters.status !== "all") query.set("status", filters.status);
  return useQuery({ queryKey: ["admin", "users", filters], queryFn: async () => {
    const response = await apiFetch(`/api/admin/users?${query}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not load accounts");
    return { users: body as ManagedUser[], total: Number(response.headers.get("X-Total-Count") ?? body.length) };
  } });
}

let baseUrl: string | null = null;
let authTokenGetter: (() => string | null) | null = null;

export type User = {
  id?: string;
  fullname?: string;
  email?: string;
  role?: string;
  avatarUrl?: string;
  status?: string;
  createdAt?: string;
  enrolledCourses?: number;
  completedLessons?: number;
  [key: string]: any;
};

export type Course = {
  id: string;
  title: string;
  description?: string;
  thumbnailUrl?: string;
  lessonCount?: number;
  enrollmentCount?: number;
  completionRate?: number;
  isEnrolled?: boolean;
  lessons?: Array<{
    id: string;
    title: string;
    contentType?: string;
    isCompleted?: boolean;
    isLocked?: boolean;
    duration?: number | null;
    parts?: Array<Record<string, any>>;
  }>;
  [key: string]: any;
};

export type Lesson = {
  id: string;
  title: string;
  contentType?: string;
  fileUrl?: string;
  description?: string;
  duration?: number | null;
  parts?: Array<Record<string, any>>;
  completedPartIds?: string[];
  completedPartIndexes?: number[];
  downloadedPartIds?: string[];
  [key: string]: any;
};

export type ApiError = {
  status?: number;
  message?: string;
  error?: string;
  data?: Record<string, any>;
};

export type StudentStats = {
  totalEnrolled?: number;
  completedCourses?: number;
  completedLessons?: number;
  remainingLessons?: number;
  overallProgress?: number;
};

export type EnrolledCourseSummary = {
  courseId: string;
  courseTitle: string;
  thumbnailUrl?: string | null;
  totalLessons: number;
  completedLessons: number;
  progressPercent: number;
  isCompleted: boolean;
  lastActivityAt?: string | null;
};

export type StudentProgress = {
  totalEnrolled?: number;
  totalCompleted?: number;
  totalLessons?: number;
  completedLessons?: number;
  enrolledCourses?: EnrolledCourseSummary[];
};

function buildUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (!baseUrl) return normalizedPath;
  return `${baseUrl}${normalizedPath}`;
}

export type CourseDownload = {
  lessonId: string;
  lessonTitle: string;
  partId: string;
  partTitle: string;
  isDownloadable: boolean;
  isDownloaded: boolean;
  unavailableReason: string | null;
  downloadUrl: string | null;
};

function getAuthHeader(): Record<string, string> {
  const token = authTokenGetter?.();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  Object.entries(getAuthHeader()).forEach(([key, value]) => headers.set(key, value));
  return fetch(buildUrl(path), { ...init, headers, credentials: "include" });
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers || {});
  headers.set("Accept", "application/json");

  const isJsonBody = init.body && typeof init.body === "string";
  if (isJsonBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const authHeaders = getAuthHeader();
  Object.entries(authHeaders).forEach(([key, value]) => headers.set(key, value));

  const response = await fetch(buildUrl(path), {
  ...init,
  headers,
  credentials: "include",
});

  const text = await response.text();
  let payload: any = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const message = payload?.message || payload?.error || payload?.data?.error || "Request failed";
    const error: ApiError = { message, data: payload, status: response.status };
    throw error;
  }

  return payload as T;
}

export async function downloadLessonPart(lessonId: string, partId: string, title?: string): Promise<{ blob: Blob; filename: string }> {
  return downloadFile(`/api/lessons/${lessonId}/parts/${partId}/download`, title);
}

async function downloadFile(path: string, title?: string): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(buildUrl(path), {
    headers: getAuthHeader(),
    credentials: "include",
  });
  if (!response.ok) {
    let message = "Download failed";
    try {
      const payload = await response.json();
      message = payload?.error || payload?.message || message;
    } catch { /* Keep the generic message for non-JSON file-host errors. */ }
    throw new Error(message);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const encodedFilename = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  let filename = disposition.match(/filename="([^"]+)"/i)?.[1] ?? "";
  if (encodedFilename) {
    try { filename = decodeURIComponent(encodedFilename); } catch { /* Use the title fallback. */ }
  }
  if (title) {
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    const extension = filename.match(/\.[a-z0-9]{1,8}$/i)?.[0] ??
      ({ "application/zip": ".zip", "application/pdf": ".pdf", "video/mp4": ".mp4", "video/webm": ".webm", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/wav": ".wav" } as Record<string, string>)[type ?? ""] ?? "";
    const name = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").trim().replace(/[. ]+$/, "") || "download";
    filename = name + (extension && !name.toLowerCase().endsWith(extension.toLowerCase()) ? extension : "");
  }
  return {
    blob: await response.blob(),
    filename: filename || "lesson-download",
  };
}

export function downloadLesson(lessonId: string, title?: string): Promise<{ blob: Blob; filename: string }> {
  return downloadFile(`/api/lessons/${lessonId}/download`, title);
}

export function downloadCourse(courseId: string, title?: string): Promise<{ blob: Blob; filename: string }> {
  return downloadFile(`/api/courses/${courseId}/download`, title);
}

export function saveDownloadedFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export async function saveFilesAsZip(
  files: Array<{ blob: Blob; filename: string }>,
  archiveFilename: string,
): Promise<void> {
  if (files.length === 0) {
    throw new Error("No downloadable files were found.");
  }

  const zip = new JSZip();
  files.forEach(({ blob, filename }) => zip.file(filename, blob));
  const archive = await zip.generateAsync({ type: "blob" });
  saveDownloadedFile(archive, archiveFilename);
}

export function setBaseUrl(url: string | null): void {
  baseUrl = url?.replace(/\/$/, "") ?? null;
}

export function setAuthTokenGetter(getter: () => string | null): void {
  authTokenGetter = getter;
}

function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getAuthToken(): string | null {
  const storage = safeStorage();
  return storage?.getItem("elearn_token") ?? null;
}

export function setAuthToken(token: string): void {
  const storage = safeStorage();
  storage?.setItem("elearn_token", token);
}

export function clearAuthToken(): void {
  const storage = safeStorage();
  storage?.removeItem("elearn_token");
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").trim();
const fallbackApiBaseUrl = "https://backendfortskmlm-a3qy.onrender.com";
setBaseUrl(apiBaseUrl || fallbackApiBaseUrl);
setAuthTokenGetter(getAuthToken);

function buildQueryOptions<T>(defaultKey: unknown[], options?: { query?: Record<string, any> }, queryFn?: () => Promise<T>) {
  const { queryKey, ...queryOptions } = options?.query ?? {};
  const tracksProgress = ["courses", "lessons", "student", "certificates"].includes(String(defaultKey[0]));
  return {
    queryKey: queryKey ?? defaultKey,
    queryFn,
    ...(tracksProgress ? { staleTime: 0, refetchOnMount: "always" as const, refetchOnWindowFocus: true, refetchInterval: 30_000 } : {}),
    ...queryOptions,
  };
}

export const getGetMeQueryKey = () => ["auth", "me"];
export function useGetMe(options?: { query?: Record<string, any> }) {
  return useQuery({
    ...buildQueryOptions(getGetMeQueryKey(), options, () => apiRequest<User>("/api/auth/me")),
  });
}

export function useLogout() {
  return useMutation({
    mutationFn: () => apiRequest("/api/auth/logout", { method: "POST" }),
  });
}

export function useLogin() {
  return useMutation({
    mutationFn: ({ data }: { data: Record<string, any> }) =>
      apiRequest<{ token: string; user: User }>('/api/auth/login', {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });
}

export function useRegister() {
  return useMutation({
    mutationFn: ({ data }: { data: Record<string, any> }) =>
      apiRequest<{ token: string; user: User }>('/api/auth/register', {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });
}

export function useUpdateProfile() {
  return useMutation({
    mutationFn: ({ data }: { data: Record<string, any> }) =>
      apiRequest<User>("/api/auth/profile", {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
  });
}

export const getListCoursesQueryKey = () => ["courses"];
export function useListCourses(params?: { search?: string }, options?: { query?: Record<string, any> }) {
  const query = new URLSearchParams();
  if (params?.search) query.set("search", params.search);
  const queryString = query.toString() ? `?${query.toString()}` : "";

  return useQuery({
    ...buildQueryOptions(getListCoursesQueryKey(), options, () => apiRequest<Course[]>(`/api/courses${queryString}`)),
  });
}

export function useCreateCourse() {
  return useMutation({
    mutationFn: ({ data }: { data: Record<string, any> }) =>
      apiRequest<Course>("/api/courses", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });
}

export function useDeleteCourse() {
  return useMutation({
    mutationFn: ({ id }: { id: string }) => apiRequest(`/api/courses/${id}`, { method: "DELETE" }),
  });
}

export const getGetCourseQueryKey = (id: string) => ["courses", id];
export function useGetCourse(id: string, options?: { query?: Record<string, any> }) {
  return useQuery({
    ...buildQueryOptions(getGetCourseQueryKey(id), options, () => apiRequest<Course>(`/api/courses/${id}`)),
  });
}

export const getGetLessonQueryKey = (id: string) => ["lessons", id];
export function useGetLesson(id: string, options?: { query?: Record<string, any> }) {
  return useQuery({
    ...buildQueryOptions(getGetLessonQueryKey(id), options, () => apiRequest<Lesson>(`/api/lessons/${id}`)),
  });
}

export function useCompleteLesson() {
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data?: Record<string, any> }) =>
      apiRequest(`/api/lessons/${id}/complete`, {
        method: "POST",
        body: JSON.stringify(data ?? {}),
      }),
  });
}

export function useCompleteLessonPart() {
  return useMutation({
    mutationFn: ({ id, partId, lessonUpdatedAt }: { id: string; partId: string; lessonUpdatedAt?: string }) =>
      apiRequest<{ completedPartIds: string[] }>(`/api/lessons/${id}/parts/${partId}/complete`, {
        method: "POST",
        body: JSON.stringify({ lessonUpdatedAt }),
      }),
  });
}

export const getGetCourseDownloadsQueryKey = (courseId: string) => ["courses", courseId, "downloads"];
export function useGetCourseDownloads(courseId: string, options?: { query?: Record<string, any> }) {
  return useQuery<{ courseId: string; downloadableCount: number; items: CourseDownload[] }>({
    ...buildQueryOptions(getGetCourseDownloadsQueryKey(courseId), options, () => apiRequest(`/api/courses/${courseId}/downloads`)),
  });
}

export function useUpdateLessonProgress() {
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, any> }) =>
      apiRequest(`/api/lessons/${id}/progress`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
  });
}

export const getListLessonsQueryKey = (courseId: string) => ["courses", courseId, "lessons"];
export const getGetCourseProgressQueryKey = (courseId: string) => ["courses", courseId, "progress"];

export function useUpdateCourse() {
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, any> }) =>
      apiRequest<Course>(`/api/courses/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
  });
}

export function useCreateLesson() {
  return useMutation({
    mutationFn: ({ courseId, data }: { courseId: string; data: Record<string, any> }) =>
      apiRequest<Lesson>(`/api/courses/${courseId}/lessons`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });
}

export function useReorderLessons() {
  return useMutation({
    mutationFn: ({ courseId, lessonIds }: { courseId: string; lessonIds: string[] }) =>
      apiRequest(`/api/courses/${courseId}/lessons/reorder`, {
        method: "PATCH",
        body: JSON.stringify({ lessonIds }),
      }),
  });
}

export function useUpdateLesson() {
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, any> }) =>
      apiRequest<Lesson>(`/api/lessons/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
  });
}

export function useDeleteLesson() {
  return useMutation({
    mutationFn: ({ id }: { id: string }) => apiRequest(`/api/lessons/${id}`, { method: "DELETE" }),
  });
}

export function useEnrollCourse() {
  return useMutation({
    mutationFn: ({ id }: { id: string }) => apiRequest(`/api/courses/${id}/enroll`, { method: "POST" }),
  });
}

export const getGetMyProgressQueryKey = () => ["student", "progress"];
export function useGetMyProgress(options?: { query?: Record<string, any> }) {
  return useQuery<StudentProgress>({
    ...buildQueryOptions(getGetMyProgressQueryKey(), options, () => apiRequest<StudentProgress>(`/api/student/progress`)),
  });
}

export const getGetStudentStatsQueryKey = () => ["student", "stats"];
export function useGetStudentStats(options?: { query?: Record<string, any> }) {
  return useQuery<StudentStats>({
    ...buildQueryOptions(getGetStudentStatsQueryKey(), options, () => apiRequest<StudentStats>(`/api/student/stats`)),
  });
}

export const getCourseAssignmentQueryKey = (courseId: string) => ["courses", courseId, "assignment"];
export function useGetCourseAssignment(courseId: string, options?: { query?: Record<string, any> }) {
  return useQuery({
    ...buildQueryOptions(getCourseAssignmentQueryKey(courseId), options, () => apiRequest<{ hasSubmission: boolean; id?: string; submissionUrl?: string; status?: string; reviewedAt?: string; createdAt?: string; updatedAt?: string; }>(`/api/courses/${courseId}/assignment`)),
  });
}

export function useSubmitCourseAssignment() {
  return useMutation({
    mutationFn: ({ courseId, data }: { courseId: string; data: { submissionUrl: string } }) =>
      apiRequest(`/api/courses/${courseId}/assignment`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });
}

export const getAdminAssignmentsQueryKey = () => ["admin", "assignments"];
export function useGetAdminAssignments(options?: { query?: Record<string, any> }) {
  return useQuery({
    ...buildQueryOptions(getAdminAssignmentsQueryKey(), options, () => apiRequest<any[]>(`/api/admin/assignments`)),
  });
}

export function useReviewAssignmentStatus() {
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: { status: "approved" | "rejected" } }) =>
      apiRequest(`/api/admin/assignments/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
  });
}

export const getListUsersQueryKey = () => ["admin", "users"];
export function useListUsers(options?: { query?: Record<string, any> }) {
  return useQuery({
    ...buildQueryOptions(getListUsersQueryKey(), options, () => apiRequest<ManagedUser[]>(`/api/admin/users`)),
  });
}





export function useUpdateUserStatus() {
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, any> }) =>
      apiRequest(`/api/admin/users/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
  });
}

export function useGetAdminStats(options?: { query?: Record<string, any> }) {
  return useQuery({
    ...buildQueryOptions(["admin", "stats"], options, () => apiRequest(`/api/admin/stats`)),
  });
}

export function useGetPopularCourses(options?: { query?: Record<string, any> }) {
  return useQuery({
    ...buildQueryOptions(["admin", "popular-courses"], options, () => apiRequest(`/api/admin/popular-courses`)),
  });
}

export const getGetCertificateQueryKey = (courseId: string) => ["certificates", courseId];
export function useGetCertificate(courseId: string, options?: { query?: Record<string, any> }) {
  return useQuery({
    ...buildQueryOptions(getGetCertificateQueryKey(courseId), options, () => apiRequest(`/api/certificates/${courseId}`)),
  });
}
