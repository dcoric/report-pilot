import { OidcBackedAuthProviderService } from "./base";

export class OidcAuthProviderService extends OidcBackedAuthProviderService {
  type = "oidc" as const;
}
