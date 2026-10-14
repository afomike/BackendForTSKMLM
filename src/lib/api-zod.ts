import { z } from "zod";

export const RegisterBody = z.object({
  fullname: z.string().trim().min(2).max(200),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(6).refine(value => Buffer.byteLength(value, "utf8") <= 72, "Password must be at most 72 bytes"),
});

export const LoginBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export const UpdateProfileBody = z.object({
  fullname: z.string().trim().min(2).max(200).optional(),
  avatarUrl: z.union([z.string().url(), z.literal("")]).nullable().optional(),
}).refine(value => Object.keys(value).length > 0, "Provide at least one profile field");

export const CreateUserBody = RegisterBody.extend({
  role: z.enum(["student", "admin"]).default("student"),
});

export const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: RegisterBody.shape.password,
}).refine(value => value.currentPassword !== value.newPassword, "Choose a different password");

export const UpdateUserRoleBody = z.object({ role: z.enum(["student", "admin"]) });

export const ListCoursesQueryParams = z.object({
  search: z.coerce.string().trim().optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const CreateCourseBody = z.object({
  title: z.string().min(3),
  description: z.string(),
  thumbnailUrl: z.string().nullable().optional(),
});

export const UpdateCourseParams = z.object({
  id: z.coerce.string(),
});

export const UpdateCourseBody = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  thumbnailUrl: z.string().nullable().optional(),
});

export const GetCourseParams = z.object({
  id: z.coerce.string(),
});

export const DeleteCourseParams = z.object({
  id: z.coerce.string(),
});

export const EnrollCourseParams = z.object({
  id: z.coerce.string(),
});

export const ListLessonsParams = z.object({
  courseId: z.coerce.string(),
});

export const CreateLessonParams = z.object({
  courseId: z.coerce.string(),
});

export const LessonPartSchema = z.object({
  partId: z.string().optional(),
  title: z.string().trim().min(1),
  contentType: z.enum(["video", "audio", "pdf"]),
  fileUrl: z.string().trim().min(1),
  description: z.string().optional(),
  duration: z.number().nullable().optional(),
  // Undefined uses the safe default: YouTube content is streaming-only and
  // uploaded/hosted files can be downloaded.
  downloadable: z.boolean().optional(),
});

export const CreateLessonBody = z.object({
  title: z.string().min(2),
  lessonOrder: z.number(),
  contentType: z.enum(["video", "audio", "pdf"]).optional(),
  fileUrl: z.string().optional(),
  parts: z.array(LessonPartSchema).min(1),
  duration: z.number().nullable().optional(),
});

export const ReorderLessonsParams = z.object({
  courseId: z.coerce.string(),
});

export const ReorderLessonsBody = z.object({
  lessonIds: z.array(z.string()).min(1),
});

export const GetLessonParams = z.object({
  id: z.coerce.string(),
});

export const UpdateLessonParams = z.object({
  id: z.coerce.string(),
});

export const UpdateLessonBody = z.object({
  title: z.string().optional(),
  lessonOrder: z.number().optional(),
  contentType: z.enum(["video", "audio", "pdf"]).optional(),
  fileUrl: z.string().optional(),
  parts: z.array(LessonPartSchema).min(1).refine(parts => {
    const ids = parts.flatMap(part => part.partId ? [part.partId] : []);
    return new Set(ids).size === ids.length;
  }, "Part IDs must be unique").optional(),
  duration: z.number().nullable().optional(),
});

export const DeleteLessonParams = z.object({
  id: z.coerce.string(),
});

export const CompleteLessonBody = z.object({
  lessonId: z.string(),
});

export const GetCourseProgressParams = z.object({
  courseId: z.coerce.string(),
});

export const GetCertificateParams = z.object({
  courseId: z.coerce.string(),
});

export const RequestUploadUrlBody = z.object({
  name: z.string().min(1),
  size: z.number().int().positive(),
  contentType: z.string().min(1),
});

export const RequestUploadUrlResponse = z.object({
  uploadURL: z.string(),
  objectPath: z.string(),
  metadata: z.object({
    name: z.string(),
    size: z.number(),
    contentType: z.string(),
  }),
});

export const UpdateUserStatusParams = z.object({
  id: z.string().uuid(),
});

export const UpdateUserStatusBody = z.object({
  status: z.enum(["active", "suspended"]),
});

