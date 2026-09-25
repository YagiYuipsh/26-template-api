export type EventDocument = {
    owner: string;
    title: string;
    startsAt: Date;
    endsAt: Date;
    description?: string;
    venue?: string;
    version: number;
    createdAt: Date;
    updatedAt: Date;
};
