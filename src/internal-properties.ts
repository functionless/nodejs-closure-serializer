import inspector from "inspector";
import util from "util";
import { getValueForObjectId } from "./free-variable";
import { GetPropertiesSession, inspectorSession } from "./inspector-session";

export interface InternalProperties {
  "[[BoundThis]]"?: any;
  "[[BoundArgs]]"?: any;
  "[[Prototype]]"?: any;
  "[[Scopes]]"?: any;
  "[[TargetFunction]]"?: Function;
}

/**
 * Get all of the Internal
 * @param objectId
 * @param ownProperties
 * @returns
 */
export async function getInternalProperties(
  objectId: inspector.Runtime.RemoteObjectId,
  ownProperties: boolean | undefined
): Promise<InternalProperties> {
  const session = <GetPropertiesSession>await inspectorSession;
  const post = util.promisify(session.post);

  // This cast will become unnecessary when we move to TS 3.1.6 or above.  In that version they
  // support typesafe '.call' calls.
  const retType = await post.call(session, "Runtime.getProperties", {
    objectId,
    ownProperties,
  });
  if (retType.exceptionDetails) {
    throw new Error(
      `Error calling "Runtime.getProperties(${objectId}, ${ownProperties})": ` +
        retType.exceptionDetails.text
    );
  }

  return Object.fromEntries(
    await Promise.all(
      (retType.internalProperties ?? [])
        .filter(
          (
            prop
          ): prop is typeof prop & {
            value: {
              objectId: string;
            };
          } => prop.value?.objectId !== undefined
        )
        .map(async (prop) => [
          prop.name,
          await getValueForObjectId(prop.value.objectId),
        ])
    )
  );
}
