import { AuthProviderService } from "./index";
import { ProviderRow } from "../authProviderService";
import { buildConfiguration, startLogin, completeLogin, testConnection } from "../oidcService";

export class OidcAuthProviderService implements AuthProviderService {
  type = "oidc" as const;

  async startLogin(provider: ProviderRow): Promise<{ authorizeUrl: string; flowState: any }> {
    return startLogin(provider);
  }

  async completeLogin(provider: ProviderRow, currentUrl: string, flowState: any): Promise<any> {
    return completeLogin(provider, currentUrl, flowState);
  }

  async testConnection(provider: ProviderRow): Promise<any> {
    return testConnection(provider);
  }

  buildPrincipal(claims: any): any {
    // Return the standard external principal format for OIDC
    return {
      email: claims.email,
      sub: claims.sub,
      display_name: claims.name,
      claims
    };
  }
}