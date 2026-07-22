// Auth provider factory - handles creation of provider-specific service instances
import { AuthProviderType } from "../../types/domain";
import { OidcAuthProviderService } from "./oidc";
import { SamlAuthProviderService } from "./saml";
import { LdapAuthProviderService } from "./ldap";
import { AdAuthProviderService } from "./ad";
import { PdAuthProviderService } from "./pd";

export interface AuthProviderService {
  type: AuthProviderType;
  startLogin(provider: any): Promise<{ authorizeUrl: string; flowState: any }>;
  completeLogin(provider: any, currentUrl: string, flowState: any): Promise<any>;
  testConnection(provider: any): Promise<any>;
  buildPrincipal(claims: any): any;
}

export function createAuthProviderService(type: AuthProviderType): AuthProviderService {
  switch (type) {
    case "oidc":
      return new OidcAuthProviderService();
    case "saml":
      return new SamlAuthProviderService();
    case "ldap":
      return new LdapAuthProviderService();
    case "ad":
      return new AdAuthProviderService();
    case "pd":
      return new PdAuthProviderService();
    default:
      throw new Error(`Unsupported auth provider type: ${type}`);
  }
}

export { OidcAuthProviderService, SamlAuthProviderService, LdapAuthProviderService, AdAuthProviderService, PdAuthProviderService };