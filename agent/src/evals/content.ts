// What the eval tools read: the site's content plus a placeholder contact
// address. The real one lives only in Secret Manager (#51), so recordings stay
// deterministic and never hold it.
import { siteContent, type Content } from "../tools";

export const evalContactEmail = "alberto@example.com";

export const evalContent: Content = { ...siteContent, contactEmail: evalContactEmail };
