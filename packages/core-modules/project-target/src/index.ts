export {
  AppTargetAggregate,
  AppTargetChanged,
  ProjectTargetError,
} from "./domain/app-target.js";

export type {
  ProjectTargetErrorCode,
  UpdateAppTargetCommand,
} from "./domain/app-target.js";

export { createTargetRevision } from "./domain/target-revision.js";
export type {
  CreateTargetRevisionInput,
  DesktopTargetConfiguration,
  TargetConfiguration,
  TargetRevision,
  WebTargetConfiguration,
} from "./domain/target-revision.js";
export type {
  ProjectTargetRepository,
  SaveTargetRevisionInput,
} from "./application/project-target-repository.js";
export { ProjectTargetService } from "./application/project-target-service.js";
export type { CreateTargetCommand } from "./application/project-target-service.js";
