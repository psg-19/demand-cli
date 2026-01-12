import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import * as docker_build from "@pulumi/docker-build";

export interface ImageManagementArgs {
    appName: string;
    dockerContext: string;
    dockerfile: string;
    imageTag?: string;
}

export interface ImageManagementOutputs {
    repositoryUrl: pulumi.Output<string>;
    repositoryName: pulumi.Output<string>;
    imageRef: pulumi.Output<string>;
}

export class ImageManagement extends pulumi.ComponentResource implements ImageManagementOutputs {
    public readonly repositoryUrl: pulumi.Output<string>;
    public readonly repositoryName: pulumi.Output<string>;
    public readonly imageRef: pulumi.Output<string>;

    constructor(name: string, args: ImageManagementArgs, opts?: pulumi.ComponentResourceOptions) {
        super('custom:component:ImageManagement', name, {}, opts);

        const {
            appName,
            dockerContext,
            dockerfile,
            imageTag = 'latest'
        } = args;

        const repo = new aws.ecr.Repository(`${appName}-repo`, {
            name: `${appName}`,
            imageScanningConfiguration: {
                scanOnPush: false,
            },
        }, { parent: this });

        const getCredentials = repo.registryId.apply(async (_registryId) => {
            const creds = await aws.ecr.getAuthorizationToken({});
            const [username, password] = Buffer.from(creds.authorizationToken, 'base64')
            .toString()
            .split(':');
            return {
                address: repo.repositoryUrl,
                username,
                password,
            };
        });

        new aws.ecr.LifecyclePolicy(`${appName}-lifecycle`, {
            repository: repo.name,
            policy: JSON.stringify({
                rules: [
                    {
                        rulePriority: 1,
                        description: 'Keep only the last 10 images',
                        selection: {
                            tagStatus: 'any',
                            countType: 'imageCountMoreThan',
                            countNumber: 10,
                        },
                        action: {
                            type: 'expire',
                        },
                    },
                ],
            }),
        }, { parent: this });

        const image = new docker_build.Image(`${appName}-image`, {
            tags: [pulumi.interpolate`${repo.repositoryUrl}:${imageTag}`],
            dockerfile: {
                location: dockerfile
            },
            context: {
                location: dockerContext
            },
            platforms: ['linux/amd64'],
            buildArgs: {
                BUILD_DATE: new Date().toISOString(),
            },
            cacheFrom: [{
                registry: {
                    ref: pulumi.interpolate`${repo.repositoryUrl}:cache`,
                },
            }],
            cacheTo: [{
                registry: {
                    imageManifest: true,
                    ociMediaTypes: true,
                    ref: pulumi.interpolate`${repo.repositoryUrl}:cache`,
                },
            }],
            registries: [{
                address: pulumi.interpolate`${repo.repositoryUrl}`,
                //@ts-ignore
                username: getCredentials.username,
                //@ts-ignore
                password: getCredentials.password
            }],
            push: true,
        }, { parent: this });

        this.repositoryUrl = repo.repositoryUrl;
        this.repositoryName = repo.name;
        this.imageRef = image.ref;

        this.registerOutputs({
            repositoryUrl: this.repositoryUrl,
            repositoryName: this.repositoryName,
            imageRef: this.imageRef,
        });
    }
}
