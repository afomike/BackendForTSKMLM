import { z } from "zod";

export const RegisterBody = z.object({
  fullname: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
});

export const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const UpdateProfileBody = z.object({
  fullname: z.string().optional(),
  avatarUrl: z.string().nullable().optional(),
});

export const ListCoursesQueryParams = z.object({
  search: z.coerce.string().optional(),
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
  title: z.string().min(1),
  contentType: z.enum(["video", "audio", "pdf"]),
  fileUrl: z.string().min(1),
  description: z.string().optional(),
  duration: z.number().nullable().optional(),
});

export const CreateLessonBody = z.object({
  title: z.string().min(2),
  lessonOrder: z.number(),
  contentType: z.enum(["video", "audio", "pdf"]).optional(),
  fileUrl: z.string().optional(),
  parts: z.array(LessonPartSchema).min(1),
  duration: z.number().nullable().optional(),
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
  parts: z.array(LessonPartSchema).optional(),
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
  id: z.coerce.string(),
});

export const UpdateUserStatusBody = z.object({
  status: z.enum(["active", "suspended"]),
});

